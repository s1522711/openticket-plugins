import {api, opendiscord, utilities} from "#opendiscord"
import * as discord from "discord.js"
import * as fs from "fs"

if (utilities.project != "openticket") throw new api.ODPluginError("This plugin only works in Open Ticket!")

// ─── Constants ────────────────────────────────────────────────────────────────
const CONFIG_PATH = "./plugins/ping-detector/config.json"
const DATA_PATH   = "./plugins/ping-detector/data.json"
const WEEK_MS     = 7 * 24 * 60 * 60 * 1000

// ─── Types ────────────────────────────────────────────────────────────────────
interface PingDetectorConfig {
    staffRoles:         string[]
    baseTimeoutSeconds: number
}

interface UserPingRecord {
    count:     number   // pings this week
    expiresAt: number   // unix ms when the week-window closes
}

interface PingData {
    [userId: string]: UserPingRecord
}

// ─── Config / data helpers ────────────────────────────────────────────────────
function loadConfig(): PingDetectorConfig {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) }
    catch { return { staffRoles: [], baseTimeoutSeconds: 20 } }
}

function saveConfig(cfg: PingDetectorConfig): void {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4), "utf-8")
}

function loadData(): PingData {
    try {
        const raw: PingData = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"))
        // Prune expired entries on every load
        const now = Date.now()
        for (const userId of Object.keys(raw)) {
            if (raw[userId].expiresAt <= now) delete raw[userId]
        }
        return raw
    } catch { return {} }
}

function saveData(data: PingData): void {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 4), "utf-8")
}

// ─── Core handler ─────────────────────────────────────────────────────────────
async function handleMessage(message: discord.Message): Promise<void> {
    if (message.author.bot) return
    if (!message.guild || !message.member) return
    if (message.mentions.users.size === 0) return

    const cfg        = loadConfig()
    const staffRoles = cfg.staffRoles
    if (staffRoles.length === 0) return

    // Ignore global admins and users who already have a staff role
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    const globalAdmins: string[] = generalConfig?.data?.globalAdmins ?? []
    const senderRoles = message.member.roles.cache
    const senderIsAdmin     = globalAdmins.some(roleId => senderRoles.has(roleId))
    const senderIsStaff     = staffRoles.some(roleId => senderRoles.has(roleId))
    const senderIsDiscordAdmin = message.member.permissions.has(discord.PermissionFlagsBits.Administrator)
    if (senderIsAdmin || senderIsStaff || senderIsDiscordAdmin) return

    // Count how many distinct staff members were pinged
    let staffPingCount = 0
    for (const [userId, user] of message.mentions.users) {
        if (user.bot) continue
        if (userId === message.author.id) continue
        const mentioned = await message.guild.members.fetch(userId).catch(() => null)
        if (!mentioned) continue
        if (staffRoles.some(roleId => mentioned.roles.cache.has(roleId))) {
            staffPingCount++
        }
    }
    if (staffPingCount === 0) return

    // ── Lookup / update the sender's ping record ─────────────────────────────
    const data   = loadData()
    const now    = Date.now()
    const record = data[message.author.id]
    let count: number
    let expiresAt: number

    if (!record || record.expiresAt <= now) {
        count     = staffPingCount
        expiresAt = now + WEEK_MS
    } else {
        count     = record.count + staffPingCount
        expiresAt = record.expiresAt
    }

    data[message.author.id] = { count, expiresAt }
    saveData(data)

    // ── Apply timeout ─────────────────────────────────────────────────────────
    const timeoutMs = count * cfg.baseTimeoutSeconds * 1000
    try {
        await message.member.timeout(timeoutMs, `Staff ping #${count} (${staffPingCount} in this message) (ping-detector)`)
    } catch {
        opendiscord.log(`Ping Detector: Could not timeout ${message.author.username} — missing permissions or role hierarchy`, "warning")
    }

    // ── Warning message (always) ──────────────────────────────────────────────
    const channel = message.channel as discord.TextChannel
    const multiNote = staffPingCount > 1 ? ` (you pinged ${staffPingCount} staff members at once!)` : ""
    await channel.send(
        `please dont ping staff!${multiNote} ${message.author}\nhope you understand :)`
    ).catch(() => {})

    // ── Escalation message (2nd ping onwards) ────────────────────────────────
    if (count >= 2) {
        const expireTimestamp = Math.floor(expiresAt / 1000)
        await channel.send(
            `By the way, you might have noticed that your timeout is longer than before, ` +
            `this is because you have ${count} staff pings this week. ` +
            `Your multiplier expires on <t:${expireTimestamp}:F>.`
        ).catch(() => {})
    }

    opendiscord.log(
        `Ping Detector: ${message.author.username} timed out for ${timeoutMs / 1000}s (${staffPingCount} staff pinged, total count: ${count})`,
        "plugin"
    )
}

// ─── /ping-detector slash command ────────────────────────────────────────────
opendiscord.events.get("onSlashCommandLoad").listen((slashCommands) => {
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    if (!generalConfig?.data?.slashCommands) return

    const role = discord.ApplicationCommandOptionType.Role
    const user = discord.ApplicationCommandOptionType.User
    const sub  = discord.ApplicationCommandOptionType.Subcommand

    slashCommands.add(new api.ODSlashCommand("ping-detector:manage", {
        type: discord.ApplicationCommandType.ChatInput,
        name: "ping-detector",
        description: "Manage the staff ping detector (admin only)",
        contexts:         [discord.InteractionContextType.Guild],
        integrationTypes: [discord.ApplicationIntegrationType.GuildInstall],
        options: [
            {
                name: "add-role", type: sub,
                description: "Add a role to the staff list",
                options: [{ name: "role", type: role, required: true,
                    description: "The role to protect from pings" }]
            },
            {
                name: "remove-role", type: sub,
                description: "Remove a role from the staff list",
                options: [{ name: "role", type: role, required: true,
                    description: "The role to remove" }]
            },
            {
                name: "roles", type: sub,
                description: "List all current staff roles"
            },
            {
                name: "status", type: sub,
                description: "Show a user's current ping count and expiry",
                options: [{ name: "user", type: user, required: true,
                    description: "The user to look up" }]
            },
            {
                name: "reset", type: sub,
                description: "Reset a user's ping count",
                options: [{ name: "user", type: user, required: true,
                    description: "The user to reset" }]
            }
        ]
    }))

    opendiscord.log("Ping Detector: Registered /ping-detector slash command", "plugin")
})

// ─── Command responder ────────────────────────────────────────────────────────
opendiscord.events.get("onCommandResponderLoad").listen((commandResponders) => {
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    const globalAdmins: string[] = generalConfig?.data?.globalAdmins ?? []

    commandResponders.add(new api.ODCommandResponder("ping-detector:manage", generalConfig.data.prefix, "ping-detector"))
    commandResponders.get("ping-detector:manage")!.workers.add(
        new api.ODWorker("ping-detector:manage", 0, async (instance, _p, _s, cancel) => {
            const { user, member } = instance

            // ── Admin gate ────────────────────────────────────────────────────
            const isAdmin = globalAdmins.length === 0 ||
                globalAdmins.some(roleId => member?.roles?.cache?.has(roleId))
            if (!isAdmin) {
                await instance.reply({ id: new api.ODId("ping-detector:no-perms"), ephemeral: true,
                    message: { content: "❌ You don't have permission to use this command." } })
                return cancel()
            }

            const raw = instance.interaction
            if (!(raw instanceof discord.ChatInputCommandInteraction)) return cancel()
            const subcommand = raw.options.getSubcommand(false)
            if (!subcommand) return cancel()

            const cfg = loadConfig()

            if (subcommand === "add-role") {
                const role = raw.options.getRole("role", true)
                if (cfg.staffRoles.includes(role.id)) {
                    await instance.reply({ id: new api.ODId("ping-detector:role-exists"), ephemeral: true,
                        message: { content: `⚠️ ${role} is already a staff role.` } })
                    return cancel()
                }
                cfg.staffRoles.push(role.id)
                saveConfig(cfg)
                opendiscord.log(`Ping Detector: Staff role "${role.name}" added by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("ping-detector:role-added"), ephemeral: true,
                    message: { content: `✅ ${role} is now a protected staff role.` } })

            } else if (subcommand === "remove-role") {
                const role = raw.options.getRole("role", true)
                const idx  = cfg.staffRoles.indexOf(role.id)
                if (idx === -1) {
                    await instance.reply({ id: new api.ODId("ping-detector:role-missing"), ephemeral: true,
                        message: { content: `⚠️ ${role} is not in the staff role list.` } })
                    return cancel()
                }
                cfg.staffRoles.splice(idx, 1)
                saveConfig(cfg)
                opendiscord.log(`Ping Detector: Staff role "${role.name}" removed by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("ping-detector:role-removed"), ephemeral: true,
                    message: { content: `✅ ${role} removed from the staff role list.` } })

            } else if (subcommand === "roles") {
                if (cfg.staffRoles.length === 0) {
                    await instance.reply({ id: new api.ODId("ping-detector:roles-empty"), ephemeral: true,
                        message: { content: "No staff roles configured yet. Use `/ping-detector add-role` to add one." } })
                    return cancel()
                }
                const lines = cfg.staffRoles.map(id => `• <@&${id}>`).join("\n")
                await instance.reply({ id: new api.ODId("ping-detector:roles-list"), ephemeral: true,
                    message: { content: `**Protected staff roles:**\n${lines}` } })

            } else if (subcommand === "status") {
                const target = raw.options.getUser("user", true)
                const data   = loadData()
                const record = data[target.id]
                if (!record) {
                    await instance.reply({ id: new api.ODId("ping-detector:status-clean"), ephemeral: true,
                        message: { content: `✅ ${target} has no active ping record this week.` } })
                    return cancel()
                }
                const expireTimestamp = Math.floor(record.expiresAt / 1000)
                await instance.reply({ id: new api.ODId("ping-detector:status-found"), ephemeral: true,
                    message: { content:
                        `**${target.username}** — ping record\n` +
                        `Pings this week: **${record.count}** (next timeout: **${record.count + 1} × ${cfg.baseTimeoutSeconds}s = ${(record.count + 1) * cfg.baseTimeoutSeconds}s**)\n` +
                        `Multiplier expires: <t:${expireTimestamp}:F>`
                    }
                })

            } else if (subcommand === "reset") {
                const target = raw.options.getUser("user", true)
                const data   = loadData()
                if (!data[target.id]) {
                    await instance.reply({ id: new api.ODId("ping-detector:reset-none"), ephemeral: true,
                        message: { content: `⚠️ ${target} has no active ping record to reset.` } })
                    return cancel()
                }
                delete data[target.id]
                saveData(data)
                opendiscord.log(`Ping Detector: Record reset for ${target.username} by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("ping-detector:reset-ok"), ephemeral: true,
                    message: { content: `✅ Ping record for ${target} has been reset.` } })
            }
        })
    )
    opendiscord.log("Ping Detector: Registered /ping-detector command responder", "plugin")
})

// ─── Start listening to messages ──────────────────────────────────────────────
opendiscord.events.get("onReadyForUsage").listen(() => {
    opendiscord.client.client.on("messageCreate", (message) => {
        handleMessage(message).catch(err =>
            opendiscord.log(`Ping Detector: Error in message handler — ${err}`, "error")
        )
    })
    opendiscord.log("Ping Detector: Listening for staff pings", "plugin")
})
