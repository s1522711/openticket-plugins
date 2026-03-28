import {api, opendiscord, utilities} from "#opendiscord"
import * as discord from "discord.js"
import * as fs from "fs"
import { loadConfig as loadGameGuardConfig } from "../game-guard/index.js"

if (utilities.project != "openticket") throw new api.ODPluginError("This plugin only works in Open Ticket!")

// ─── Constants ────────────────────────────────────────────────────────────────
const CONFIG_PATH = "./plugins/status/config.json"

// ─── Types ────────────────────────────────────────────────────────────────────
export type GameStatus = "up" | "updating" | "down"

export interface StatusGame {
    name:   string
    status: GameStatus
}

export interface StatusConfig {
    channelId: string
    messageId: string
    games:     StatusGame[]
}

// ─── Config helpers ───────────────────────────────────────────────────────────
export function loadConfig(): StatusConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"))
    } catch {
        return { channelId: "", messageId: "", games: [] }
    }
}

function saveConfig(cfg: StatusConfig): void {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4), "utf-8")
}

// ─── Embed builder ────────────────────────────────────────────────────────────
const STATUS_ICON: Record<GameStatus, string> = {
    up:       "🟢",
    updating: "🟡",
    down:     "🔴"
}

const STATUS_LABEL: Record<GameStatus, string> = {
    up:       "Online",
    updating: "Updating",
    down:     "Down"
}

function overallColor(games: StatusGame[]): number {
    if (games.some(g => g.status === "down"))     return 0xE74C3C // red
    if (games.some(g => g.status === "updating")) return 0xF1C40F // yellow
    return 0x2ECC71                                               // green
}

function buildEmbed(cfg: StatusConfig): discord.APIEmbed {
    const fields: discord.APIEmbedField[] = []

    // ── Section 1: ticket availability from game-guard ────────────────────────
    try {
        const gg = loadGameGuardConfig()
        if (gg.availableGames.length > 0) {
            const lines = gg.availableGames.map(game => {
                const disabled = gg.disabledGames.some(
                    d => d.toLowerCase() === game.toLowerCase()
                )
                return disabled
                    ? `🚫 **${game}** — Closed`
                    : `✅ **${game}** — Open`
            }).join("\n")

            fields.push({
                name:   "🎫 Ticket Availability",
                value:  lines,
                inline: false
            })
        }
    } catch {
        fields.push({
            name:  "🎫 Ticket Availability",
            value: "_Could not read game-guard data._",
            inline: false
        })
    }

    // ── Section 2: server statuses from this plugin's config ──────────────────
    if (cfg.games.length > 0) {
        const lines = cfg.games.map(g =>
            `${STATUS_ICON[g.status]} **${g.name}** — ${STATUS_LABEL[g.status]}`
        ).join("\n")

        fields.push({
            name:   "🖥️ Server Status",
            value:  lines,
            inline: false
        })
    } else {
        fields.push({
            name:   "🖥️ Server Status",
            value:  "_No games configured. Use `/status add` to add one._",
            inline: false
        })
    }

    return new discord.EmbedBuilder()
        .setTitle("🎮 Game Status")
        .setColor(cfg.games.length > 0 ? overallColor(cfg.games) : 0x95A5A6)
        .addFields(fields)
        .setTimestamp()
        .setFooter({ text: "Last updated" })
        .toJSON()
}

// ─── Post or edit the status message ─────────────────────────────────────────
export async function updateStatusMessage(): Promise<void> {
    const cfg = loadConfig()
    if (!cfg.channelId) return

    try {
        const guild = opendiscord.client.mainServer
        if (!guild) return
        const channel = await guild.channels.fetch(cfg.channelId).catch(() => null)
        if (!channel || !channel.isTextBased()) return
        const textChannel = channel as discord.TextChannel
        const embed = buildEmbed(cfg)

        if (cfg.messageId) {
            const existing = await textChannel.messages.fetch(cfg.messageId).catch(() => null)
            if (existing) { await existing.edit({ embeds: [embed] }); return }
        }

        // No stored message — post a fresh one
        const sent = await textChannel.send({ embeds: [embed] })
        cfg.messageId = sent.id
        saveConfig(cfg)
    } catch (err) {
        opendiscord.log(`Status: Failed to update status message — ${err}`, "error")
    }
}

// ─── /status slash command ────────────────────────────────────────────────────
opendiscord.events.get("onSlashCommandLoad").listen((slashCommands) => {
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    if (!generalConfig?.data?.slashCommands) return

    const str  = discord.ApplicationCommandOptionType.String
    const chan = discord.ApplicationCommandOptionType.Channel
    const sub  = discord.ApplicationCommandOptionType.Subcommand

    slashCommands.add(new api.ODSlashCommand("status:manage", {
        type: discord.ApplicationCommandType.ChatInput,
        name: "status",
        description: "Manage the game status board (admin only)",
        contexts:         [discord.InteractionContextType.Guild],
        integrationTypes: [discord.ApplicationIntegrationType.GuildInstall],
        options: [
            {
                name: "set", type: sub,
                description: "Set the server status of a game",
                options: [
                    { name: "game",   type: str, required: true,  autocomplete: true,
                      description: "The game to update" },
                    { name: "status", type: str, required: true,  autocomplete: true,
                      description: "New status: up, updating, or down" }
                ]
            },
            {
                name: "add", type: sub,
                description: "Add a game to the status board",
                options: [
                    { name: "game",   type: str, required: true,
                      description: "Game name to add" },
                    { name: "status", type: str, required: false, autocomplete: true,
                      description: "Initial status (default: up)" }
                ]
            },
            {
                name: "remove", type: sub,
                description: "Remove a game from the status board",
                options: [
                    { name: "game", type: str, required: true, autocomplete: true,
                      description: "The game to remove" }
                ]
            },
            {
                name: "channel", type: sub,
                description: "Set the channel where the status embed is posted",
                options: [
                    { name: "channel", type: chan, required: true,
                      description: "The text channel to use" }
                ]
            },
            {
                name: "update", type: sub,
                description: "Force-refresh the status embed right now"
            }
        ]
    }))

    opendiscord.log("Status: Registered /status slash command", "plugin")
})

// ─── Autocomplete ─────────────────────────────────────────────────────────────
opendiscord.events.get("onAutocompleteResponderLoad").listen((autocompleteResponders) => {
    // Game autocomplete (for set/remove — existing games only)
    autocompleteResponders.add(new api.ODAutocompleteResponder("status:game-autocomplete", "status", "game"))
    autocompleteResponders.get("status:game-autocomplete")!.workers.add(
        new api.ODWorker("status:game-autocomplete", 0, async (instance, _p, _s, _c) => {
            const sub = instance.interaction.options.getSubcommand(false)
            if (sub === "add") {
                // Free text — no autocomplete needed, but provide game-guard names as suggestions
                try {
                    const gg = loadGameGuardConfig()
                    const cfg = loadConfig()
                    const existing = new Set(cfg.games.map(g => g.name.toLowerCase()))
                    const choices = gg.availableGames
                        .filter(g => !existing.has(g.toLowerCase()))
                        .map(g => ({ name: g, value: g }))
                    await instance.filteredAutocomplete(choices)
                } catch { await instance.filteredAutocomplete([]) }
            } else {
                // set/remove — existing games in status config
                const cfg = loadConfig()
                await instance.filteredAutocomplete(cfg.games.map(g => ({ name: g.name, value: g.name })))
            }
        })
    )

    // Status value autocomplete
    autocompleteResponders.add(new api.ODAutocompleteResponder("status:status-autocomplete", "status", "status"))
    autocompleteResponders.get("status:status-autocomplete")!.workers.add(
        new api.ODWorker("status:status-autocomplete", 0, async (instance, _p, _s, _c) => {
            await instance.filteredAutocomplete([
                { name: "🟢 Online",   value: "up"       },
                { name: "🟡 Updating", value: "updating" },
                { name: "🔴 Down",     value: "down"     }
            ])
        })
    )

    opendiscord.log("Status: Registered autocomplete responders", "plugin")
})

// ─── Command responder ────────────────────────────────────────────────────────
opendiscord.events.get("onCommandResponderLoad").listen((commandResponders) => {
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    const globalAdmins: string[] = generalConfig?.data?.globalAdmins ?? []

    commandResponders.add(new api.ODCommandResponder("status:manage", generalConfig.data.prefix, "status"))
    commandResponders.get("status:manage")!.workers.add(
        new api.ODWorker("status:manage", 0, async (instance, _p, _s, cancel) => {
            const { user, member } = instance

            // ── Admin gate ────────────────────────────────────────────────────
            const isAdmin = globalAdmins.length === 0 ||
                globalAdmins.some(roleId => member?.roles?.cache?.has(roleId))
            if (!isAdmin) {
                await instance.reply({ id: new api.ODId("status:no-perms"), ephemeral: true,
                    message: { content: "❌ You don't have permission to use this command." } })
                return cancel()
            }

            const raw = instance.interaction
            if (!(raw instanceof discord.ChatInputCommandInteraction)) return cancel()
            const subcommand = raw.options.getSubcommand(false)
            if (!subcommand) return cancel()

            const cfg = loadConfig()

            if (subcommand === "set") {
                const gameName = raw.options.getString("game",   true).trim()
                const newStatus = raw.options.getString("status", true).trim() as GameStatus

                if (!["up","updating","down"].includes(newStatus)) {
                    await instance.reply({ id: new api.ODId("status:bad-status"), ephemeral: true,
                        message: { content: "❌ Status must be one of: `up`, `updating`, `down`." } })
                    return cancel()
                }
                const game = cfg.games.find(g => g.name.toLowerCase() === gameName.toLowerCase())
                if (!game) {
                    await instance.reply({ id: new api.ODId("status:not-found"), ephemeral: true,
                        message: { content: `❌ **${gameName}** is not on the status board. Use \`/status add\` first.` } })
                    return cancel()
                }
                game.status = newStatus
                saveConfig(cfg)
                await updateStatusMessage()
                opendiscord.log(`Status: "${gameName}" set to ${newStatus} by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("status:set-ok"), ephemeral: true,
                    message: { content: `${STATUS_ICON[newStatus]} **${game.name}** is now **${STATUS_LABEL[newStatus]}**.` } })

            } else if (subcommand === "add") {
                const gameName  = raw.options.getString("game", true).trim()
                const initStatus = (raw.options.getString("status", false)?.trim() ?? "up") as GameStatus
                if (!["up","updating","down"].includes(initStatus)) {
                    await instance.reply({ id: new api.ODId("status:bad-status-add"), ephemeral: true,
                        message: { content: "❌ Status must be one of: `up`, `updating`, `down`." } })
                    return cancel()
                }
                if (cfg.games.some(g => g.name.toLowerCase() === gameName.toLowerCase())) {
                    await instance.reply({ id: new api.ODId("status:already-exists"), ephemeral: true,
                        message: { content: `⚠️ **${gameName}** is already on the status board.` } })
                    return cancel()
                }
                cfg.games.push({ name: gameName, status: initStatus })
                saveConfig(cfg)
                await updateStatusMessage()
                opendiscord.log(`Status: "${gameName}" added by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("status:add-ok"), ephemeral: true,
                    message: { content: `✅ **${gameName}** added to the status board as ${STATUS_ICON[initStatus]} **${STATUS_LABEL[initStatus]}**.` } })

            } else if (subcommand === "remove") {
                const gameName = raw.options.getString("game", true).trim()
                const idx = cfg.games.findIndex(g => g.name.toLowerCase() === gameName.toLowerCase())
                if (idx === -1) {
                    await instance.reply({ id: new api.ODId("status:remove-not-found"), ephemeral: true,
                        message: { content: `❌ **${gameName}** is not on the status board.` } })
                    return cancel()
                }
                cfg.games.splice(idx, 1)
                saveConfig(cfg)
                await updateStatusMessage()
                opendiscord.log(`Status: "${gameName}" removed by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("status:remove-ok"), ephemeral: true,
                    message: { content: `✅ **${gameName}** removed from the status board.` } })

            } else if (subcommand === "channel") {
                const channelOption = raw.options.getChannel("channel", true)
                if (channelOption.type !== discord.ChannelType.GuildText &&
                    channelOption.type !== discord.ChannelType.GuildAnnouncement) {
                    await instance.reply({ id: new api.ODId("status:bad-channel"), ephemeral: true,
                        message: { content: "❌ Please select a **text channel**." } })
                    return cancel()
                }
                cfg.channelId = channelOption.id
                cfg.messageId = "" // reset so a fresh message is posted
                saveConfig(cfg)
                await updateStatusMessage()
                opendiscord.log(`Status: Channel set to #${channelOption.name} by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("status:channel-set"), ephemeral: true,
                    message: { content: `✅ Status board will be posted in <#${channelOption.id}>.` } })

            } else if (subcommand === "update") {
                await updateStatusMessage()
                opendiscord.log(`Status: Manual refresh triggered by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("status:updated"), ephemeral: true,
                    message: { content: "✅ Status board refreshed." } })
            }
        })
    )
    opendiscord.log("Status: Registered /status command responder", "plugin")
})

// ─── Refresh on bot ready ─────────────────────────────────────────────────────
opendiscord.events.get("onReadyForUsage").listen(async () => {
    await updateStatusMessage()
    opendiscord.log("Status: Status board initialised", "plugin")
})

// ─── Refresh when a ticket is created (game-guard may have changed) ───────────
opendiscord.events.get("afterTicketCreated").listen(async () => {
    await updateStatusMessage()
})

// ─── Refresh when game-guard enables or disables a game ──────────────────────
opendiscord.events.get("game-guard:onGameStatusChange")!.listen(async () => {
    await updateStatusMessage()
})
