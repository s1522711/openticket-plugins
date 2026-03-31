import {api, opendiscord, utilities} from "#opendiscord"
import * as discord from "discord.js"
import * as fs from "fs"

if (utilities.project != "openticket") throw new api.ODPluginError("This plugin only works in Open Ticket!")

// Register the game-status-change event so other plugins can subscribe to it
opendiscord.events.add(new api.ODEvent("game-guard:onGameStatusChange"))

// ─── TypeScript declarations for other plugins ────────────────────────────────
declare module "#opendiscord-types" {
    export interface ODPluginManagerIds_Default {
        "game-guard": api.ODPlugin
    }
    export interface ODConfigManagerIds_Default {
        "game-guard:config": api.ODJsonConfig
    }
}

// ─── Register config with opendiscord so other plugins can read it ────────────
opendiscord.events.get("onConfigLoad").listen((configManager) => {
    configManager.add(new api.ODJsonConfig("game-guard:config", "config.json", "./plugins/game-guard/"))
})

// ─── Constants ────────────────────────────────────────────────────────────────
const CONFIG_PATH              = "./plugins/game-guard/config.json"
const GAME_QUESTION_ID         = "game-name"
const CODE_QUESTION_ID         = "faq-code"
const UNVERIFIED_ACK_QUESTION  = "unverified-aknowledgement"
const UNVERIFIED_TICKET_ID     = "unverified-support"
const ROTATE_MS                = 20 * 60 * 1000 // 20 minutes

// ─── Types ────────────────────────────────────────────────────────────────────
export interface TicketCodeConfig {
    enabled:        boolean
    channelId:      string
    messageId:      string
    currentCode:    string
    lastCode:       string
    randomization:  boolean
    customCode:     string
}

export interface GameGuardConfig {
    availableGames:  string[]
    disabledGames:   string[]
    checkedTickets:  string[]  // option IDs to check; empty = check all tickets
    ticketCode:      TicketCodeConfig
}

const DEFAULT_CODE_CONFIG: TicketCodeConfig = {
    enabled:       true,
    channelId:     "",
    messageId:     "",
    currentCode:   "1234",
    lastCode:      "0000",
    randomization: true,
    customCode:    "0000"
}

// ─── Config helpers ───────────────────────────────────────────────────────────
export function loadConfig(): GameGuardConfig {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8")
        const parsed = JSON.parse(raw)
        if (!parsed.ticketCode) parsed.ticketCode = { ...DEFAULT_CODE_CONFIG }
        if (!parsed.checkedTickets) parsed.checkedTickets = []
        return parsed
    } catch {
        return { availableGames: [], disabledGames: [], checkedTickets: [], ticketCode: { ...DEFAULT_CODE_CONFIG } }
    }
}

function saveConfig(config: GameGuardConfig): void {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), "utf-8")
}

// ─── Game helpers ─────────────────────────────────────────────────────────────
function isGameDisabled(name: string, list: string[]): boolean {
    return list.some(g => g.toLowerCase() === name.trim().toLowerCase())
}

function isGameKnown(name: string, list: string[]): boolean {
    return list.some(g => g.toLowerCase() === name.trim().toLowerCase())
}

// ─── Code helpers ─────────────────────────────────────────────────────────────
function generateRandomCode(): string {
    return Math.floor(1000 + Math.random() * 9000).toString()
}

function isCodeValid(input: string, cfg: TicketCodeConfig): boolean {
    const trimmed = input.trim()
    return trimmed === cfg.currentCode || trimmed === cfg.lastCode
}

function buildCodeEmbed(cfg: TicketCodeConfig): discord.APIEmbed {
    return new discord.EmbedBuilder()
        .setTitle("🎫 Ticket Code")
        .setDescription(
            `Enter the code below in the \`${CODE_QUESTION_ID}\` field when opening a ticket:\n\n` +
            `# \`${cfg.currentCode}\`\n\n` +
            `-# Previous code \`${cfg.lastCode}\` is also accepted for a short period.`
        )
        .setColor(0xF8BA00)
        .setFooter({ text: "This code rotates every 20 minutes and on each new ticket." })
        .toJSON()
}

async function updateCodeMessage(cfg: GameGuardConfig): Promise<void> {
    const { channelId, messageId } = cfg.ticketCode
    if (!channelId) return
    try {
        const guild = opendiscord.client.mainServer
        if (!guild) return
        const channel = await guild.channels.fetch(channelId).catch(() => null)
        if (!channel || !channel.isTextBased()) return
        const textChannel = channel as discord.TextChannel
        const embed = buildCodeEmbed(cfg.ticketCode)

        if (messageId) {
            const existing = await textChannel.messages.fetch(messageId).catch(() => null)
            if (existing) { await existing.edit({ embeds: [embed] }); return }
        }
        // No stored message — send a fresh one and persist its ID
        const sent = await textChannel.send({ embeds: [embed] })
        cfg.ticketCode.messageId = sent.id
        saveConfig(cfg)
    } catch (err) {
        opendiscord.log(`Game Guard: Failed to update code message — ${err}`, "error")
    }
}

async function rotateCode(): Promise<void> {
    const cfg = loadConfig()
    if (!cfg.ticketCode.enabled) return
    const newCode = cfg.ticketCode.randomization
        ? generateRandomCode()
        : cfg.ticketCode.customCode
    cfg.ticketCode.lastCode    = cfg.ticketCode.currentCode
    cfg.ticketCode.currentCode = newCode
    saveConfig(cfg)
    await updateCodeMessage(cfg)
    opendiscord.log(`Game Guard: Code rotated → ${newCode}`, "plugin")
}

// ─── /game-guard slash command ────────────────────────────────────────────────
opendiscord.events.get("onSlashCommandLoad").listen((slashCommands) => {
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    if (!generalConfig?.data?.slashCommands) return

    const str  = discord.ApplicationCommandOptionType.String
    const bool = discord.ApplicationCommandOptionType.Boolean
    const chan = discord.ApplicationCommandOptionType.Channel
    const sub  = discord.ApplicationCommandOptionType.Subcommand
    const grp  = discord.ApplicationCommandOptionType.SubcommandGroup

    slashCommands.add(new api.ODSlashCommand("game-guard:manage", {
        type: discord.ApplicationCommandType.ChatInput,
        name: "game-guard",
        description: "Manage game availability and ticket codes (admin only)",
        contexts:         [discord.InteractionContextType.Guild],
        integrationTypes: [discord.ApplicationIntegrationType.GuildInstall],
        options: [
            // ── Game management subcommands ──────────────────────────────────
            {
                name: "disable", type: sub,
                description: "Disable a game — prevents ticket creation for it",
                options: [{ name: "game", type: str, required: true, autocomplete: true,
                    description: "The game to disable" }]
            },
            {
                name: "enable", type: sub,
                description: "Enable a game — allows ticket creation for it again",
                options: [{ name: "game", type: str, required: true, autocomplete: true,
                    description: "The game to enable" }]
            },
            {
                name: "list", type: sub,
                description: "Show all games and their current status"
            },
            // ── Ticket code subcommand group ─────────────────────────────────
            {
                name: "code", type: grp,
                description: "Manage the ticket code system",
                options: [
                    {
                        name: "view", type: sub,
                        description: "Show the current and previous ticket code"
                    },
                    {
                        name: "enable", type: sub,
                        description: "Enable the ticket code requirement"
                    },
                    {
                        name: "disable", type: sub,
                        description: "Disable the ticket code requirement"
                    },
                    {
                        name: "randomize", type: sub,
                        description: "Toggle automatic code randomization",
                        options: [{ name: "enabled", type: bool, required: true,
                            description: "true = random codes, false = use custom code" }]
                    },
                    {
                        name: "set", type: sub,
                        description: "Set a custom code (used when randomization is off)",
                        options: [{ name: "code", type: str, required: true,
                            description: "A 4-digit code (e.g. 4829)" }]
                    },
                    {
                        name: "channel", type: sub,
                        description: "Set the channel where the live code message is posted",
                        options: [{ name: "channel", type: chan, required: true,
                            description: "The text channel to post the code in" }]
                    }
                ]
            }
        ]
    }))

    opendiscord.log("Game Guard: Registered /game-guard slash command", "plugin")
})

// ─── Autocomplete (game options) ──────────────────────────────────────────────
opendiscord.events.get("onAutocompleteResponderLoad").listen((autocompleteResponders) => {
    autocompleteResponders.add(new api.ODAutocompleteResponder("game-guard:game-autocomplete", "game-guard", "game"))
    autocompleteResponders.get("game-guard:game-autocomplete")!.workers.add(
        new api.ODWorker("game-guard:game-autocomplete", 0, async (instance, _p, _s, _c) => {
            const cfg = loadConfig()
            const sub = instance.interaction.options.getSubcommand(false)
            // For "enable": only show currently disabled games; for "disable": all available games
            const choices = (sub === "enable"
                ? cfg.disabledGames
                : cfg.availableGames
            ).map(g => ({ name: g, value: g }))
            await instance.filteredAutocomplete(choices)
        })
    )
    opendiscord.log("Game Guard: Registered autocomplete responder", "plugin")
})

// ─── /game-guard command responder ────────────────────────────────────────────
opendiscord.events.get("onCommandResponderLoad").listen((commandResponders) => {
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    const globalAdmins: string[] = generalConfig?.data?.globalAdmins ?? []

    commandResponders.add(new api.ODCommandResponder("game-guard:manage", generalConfig.data.prefix, "game-guard"))
    commandResponders.get("game-guard:manage")!.workers.add(
        new api.ODWorker("game-guard:manage", 0, async (instance, _p, _s, cancel) => {
            const { user, member } = instance

            // ── Admin gate ───────────────────────────────────────────────────
            const isAdmin = globalAdmins.length === 0 ||
                globalAdmins.some(roleId => member?.roles?.cache?.has(roleId))
            if (!isAdmin) {
                await instance.reply({ id: new api.ODId("game-guard:no-perms"), ephemeral: true,
                    message: { content: "❌ You don't have permission to use this command." } })
                return cancel()
            }

            // ── Resolve subcommand & group ───────────────────────────────────
            const raw = instance.interaction
            if (!(raw instanceof discord.ChatInputCommandInteraction)) return cancel()
            const group      = raw.options.getSubcommandGroup(false)  // null when not in a group
            const subcommand = raw.options.getSubcommand(false)
            if (!subcommand) return cancel()

            const cfg = loadConfig()

            // ════════════════════════════════════════════════════════════════
            // CODE SUBCOMMAND GROUP
            // ════════════════════════════════════════════════════════════════
            if (group === "code") {
                if (subcommand === "view") {
                    const status = cfg.ticketCode.enabled ? "✅ enabled" : "🚫 disabled"
                    const rng    = cfg.ticketCode.randomization ? "random" : `fixed (\`${cfg.ticketCode.customCode}\`)`
                    await instance.reply({ id: new api.ODId("game-guard:code-view"), ephemeral: true,
                        message: { content:
                            `**Ticket Code System** — ${status}\n` +
                            `Current code: \`${cfg.ticketCode.currentCode}\`\n` +
                            `Previous code: \`${cfg.ticketCode.lastCode}\`\n` +
                            `Mode: ${rng}`
                        }
                    })

                } else if (subcommand === "enable") {
                    if (cfg.ticketCode.enabled) {
                        await instance.reply({ id: new api.ODId("game-guard:code-already-on"), ephemeral: true,
                            message: { content: "⚠️ The ticket code requirement is already **enabled**." } })
                        return cancel()
                    }
                    cfg.ticketCode.enabled = true
                    saveConfig(cfg)
                    opendiscord.log(`Game Guard: Code requirement enabled by ${user.username}`, "plugin")
                    await instance.reply({ id: new api.ODId("game-guard:code-enabled"), ephemeral: true,
                        message: { content: "✅ Ticket code requirement is now **enabled**." } })

                } else if (subcommand === "disable") {
                    if (!cfg.ticketCode.enabled) {
                        await instance.reply({ id: new api.ODId("game-guard:code-already-off"), ephemeral: true,
                            message: { content: "⚠️ The ticket code requirement is already **disabled**." } })
                        return cancel()
                    }
                    cfg.ticketCode.enabled = false
                    saveConfig(cfg)
                    opendiscord.log(`Game Guard: Code requirement disabled by ${user.username}`, "plugin")
                    await instance.reply({ id: new api.ODId("game-guard:code-disabled"), ephemeral: true,
                        message: { content: "✅ Ticket code requirement is now **disabled**." } })

                } else if (subcommand === "randomize") {
                    const enabled = raw.options.getBoolean("enabled", true)
                    cfg.ticketCode.randomization = enabled
                    saveConfig(cfg)
                    opendiscord.log(`Game Guard: Randomization set to ${enabled} by ${user.username}`, "plugin")
                    await instance.reply({ id: new api.ODId("game-guard:code-randomize"), ephemeral: true,
                        message: { content: enabled
                            ? "✅ Code randomization is now **on**. Codes will rotate automatically."
                            : `✅ Code randomization is now **off**. Use \`/game-guard code set\` to define a fixed code.`
                        }
                    })

                } else if (subcommand === "set") {
                    const newCode = raw.options.getString("code", true).trim()
                    if (!/^\d{4}$/.test(newCode)) {
                        await instance.reply({ id: new api.ODId("game-guard:code-invalid"), ephemeral: true,
                            message: { content: "❌ The code must be exactly **4 digits** (e.g. `4829`)." } })
                        return cancel()
                    }
                    cfg.ticketCode.customCode = newCode
                    if (!cfg.ticketCode.randomization) {
                        // Apply immediately as the active code
                        cfg.ticketCode.lastCode    = cfg.ticketCode.currentCode
                        cfg.ticketCode.currentCode = newCode
                    }
                    saveConfig(cfg)
                    if (!cfg.ticketCode.randomization) await updateCodeMessage(cfg)
                    opendiscord.log(`Game Guard: Custom code set to ${newCode} by ${user.username}`, "plugin")
                    await instance.reply({ id: new api.ODId("game-guard:code-set"), ephemeral: true,
                        message: { content: cfg.ticketCode.randomization
                            ? `✅ Custom code set to \`${newCode}\`. It will be used once you disable randomization.`
                            : `✅ Active code updated to \`${newCode}\`.`
                        }
                    })

                } else if (subcommand === "channel") {
                    const channelOption = raw.options.getChannel("channel", true)
                    if (channelOption.type !== discord.ChannelType.GuildText && channelOption.type !== discord.ChannelType.GuildAnnouncement) {
                        await instance.reply({ id: new api.ODId("game-guard:code-bad-channel"), ephemeral: true,
                            message: { content: "❌ Please select a **text channel**." } })
                        return cancel()
                    }
                    cfg.ticketCode.channelId = channelOption.id
                    cfg.ticketCode.messageId = "" // reset so a new message is posted
                    saveConfig(cfg)
                    await updateCodeMessage(cfg)
                    opendiscord.log(`Game Guard: Code channel set to #${channelOption.name} by ${user.username}`, "plugin")
                    await instance.reply({ id: new api.ODId("game-guard:code-channel-set"), ephemeral: true,
                        message: { content: `✅ Code message will be posted in <#${channelOption.id}>.` } })
                }

                return
            }

            // ════════════════════════════════════════════════════════════════
            // GAME SUBCOMMANDS (no group)
            // ════════════════════════════════════════════════════════════════
            if (subcommand === "disable") {
                const game = raw.options.getString("game", true).trim()
                if (!isGameKnown(game, cfg.availableGames)) {
                    await instance.reply({ id: new api.ODId("game-guard:unknown"), ephemeral: true,
                        message: { content: `❌ **${game}** is not a recognised game.\nAvailable: ${cfg.availableGames.join(", ")}` } })
                    return cancel()
                }
                if (isGameDisabled(game, cfg.disabledGames)) {
                    await instance.reply({ id: new api.ODId("game-guard:already-disabled"), ephemeral: true,
                        message: { content: `⚠️ **${game}** is already disabled.` } })
                    return cancel()
                }
                cfg.disabledGames.push(game)
                saveConfig(cfg)
                await opendiscord.events.get("game-guard:onGameStatusChange")!.emit([])
                opendiscord.log(`Game Guard: "${game}" disabled by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("game-guard:disabled-ok"), ephemeral: false,
                    message: { content: `✅ **${game}** is now **disabled**. Players cannot open tickets for this game.` } })

            } else if (subcommand === "enable") {
                const game = raw.options.getString("game", true).trim()
                const idx  = cfg.disabledGames.findIndex(g => g.toLowerCase() === game.toLowerCase())
                if (idx === -1) {
                    await instance.reply({ id: new api.ODId("game-guard:not-disabled"), ephemeral: true,
                        message: { content: `⚠️ **${game}** is not currently disabled.` } })
                    return cancel()
                }
                cfg.disabledGames.splice(idx, 1)
                saveConfig(cfg)
                await opendiscord.events.get("game-guard:onGameStatusChange")!.emit([])
                opendiscord.log(`Game Guard: "${game}" enabled by ${user.username}`, "plugin")
                await instance.reply({ id: new api.ODId("game-guard:enabled-ok"), ephemeral: false,
                    message: { content: `✅ **${game}** is now **enabled**. Players can open tickets for this game again.` } })

            } else if (subcommand === "list") {
                const lines = cfg.availableGames.map(g => {
                    const off = isGameDisabled(g, cfg.disabledGames)
                    return `• **${g}** — ${off ? "🚫 disabled" : "✅ enabled"}`
                }).join("\n") || "_No games configured._"
                await instance.reply({ id: new api.ODId("game-guard:list"), ephemeral: true,
                    message: { content: `**Games:**\n${lines}` } })
            }
        })
    )
    opendiscord.log("Game Guard: Registered /game-guard command responder", "plugin")
})

// ─── Discord log helper ───────────────────────────────────────────────────────
async function sendBlockLog(user: discord.User, reason: string, detail: string): Promise<void> {
    const generalConfig = opendiscord.configs.get("opendiscord:general")
    if (!generalConfig?.data?.system?.logs?.enabled) return
    const logChannel = opendiscord.posts.get("opendiscord:logs")
    if (!logChannel) return
    await logChannel.send({
        id: new api.ODId("game-guard:block-log"),
        ephemeral: false,
        message: {
            embeds: [
                new discord.EmbedBuilder()
                    .setTitle("🛡️ Ticket Blocked by Game Guard")
                    .setColor(0xE74C3C)
                    .addFields(
                        { name: "User",   value: `${user} \`${user.username}\``, inline: true },
                        { name: "Reason", value: reason,                          inline: true },
                        { name: "Detail", value: detail,                          inline: false }
                    )
                    .setTimestamp()
                    .toJSON()
            ]
        }
    })
}

// ─── Modal interceptor — game + code checks ───────────────────────────────────
opendiscord.events.get("onModalResponderLoad").listen(() => {
    const ticketModal = opendiscord.responders.modals.get("opendiscord:ticket-questions")
    if (!ticketModal) {
        opendiscord.log("Game Guard: Could not find ticket-questions modal responder!", "error")
        return
    }

    // Priority 1 runs before the core handler at priority 0
    ticketModal.workers.add(
        new api.ODWorker("game-guard:check", 1, async (instance, _p, _s, cancel) => {
            const cfg = loadConfig()

            // ── Extract option ID ────────────────────────────────────────────
            // customId format: "od:ticket-questions_OPTION_ID_SOURCE"
            const customId = instance.interaction.customId
            const withoutPrefix = customId.slice("od:ticket-questions_".length)
            const parts = withoutPrefix.split("_")
            // source is the last segment; option ID is everything before it
            const optionId = parts.slice(0, -1).join("_")

            // ── Unverified acknowledgement check ─────────────────────────────
            if (optionId.toLowerCase() === UNVERIFIED_TICKET_ID) {
                const ack = instance.values.getTextField(UNVERIFIED_ACK_QUESTION, false)
                if (!ack || ack.trim().toLowerCase() !== "yes") {
                    await instance.update({
                        id: new api.ODId("game-guard:unverified-ack"), ephemeral: true,
                        message: { embeds: [new discord.EmbedBuilder()
                            .setTitle("⚠️ Acknowledgement Required")
                            .setDescription(
                                `You must type **yes** in the acknowledgement field to open this ticket.\n\n` +
                                `Please re-open the ticket form and confirm you have read the requirements.`
                            )
                            .setColor(0xE74C3C).toJSON()] }
                    })
                    cancel()
                    opendiscord.log(`Game Guard: Blocked ticket \`${optionId}\` — missing acknowledgement (${instance.user.username})`, "plugin")
                    await sendBlockLog(instance.user, "Missing acknowledgement", `Ticket: \`${optionId}\`\nAnswered: \`${ack?.trim() ?? "(empty)"}\``)
                    return
                }
            }

            // ── Ticket filter (game + code checks) ──────────────────────────
            if (cfg.checkedTickets.length > 0 && !cfg.checkedTickets.some(t => t.toLowerCase() === optionId.toLowerCase())) return

            // ── Game check ───────────────────────────────────────────────────
            const gameName = instance.values.getTextField(GAME_QUESTION_ID, false)
            if (gameName) {
                if (cfg.availableGames.length > 0 && !isGameKnown(gameName, cfg.availableGames)) {
                    await instance.update({
                        id: new api.ODId("game-guard:unknown-game"), ephemeral: true,
                        message: { embeds: [new discord.EmbedBuilder()
                            .setTitle("❓ Unknown Game")
                            .setDescription(
                                `**${gameName}** is not a recognised game.\n\n` +
                                `Available games: ${cfg.availableGames.join(", ")}`
                            )
                            .setColor(0xE67E22).toJSON()] }
                    })
                    cancel()
                    opendiscord.log(`Game Guard: Blocked ticket \`${optionId}\` — unknown game "${gameName}" (${instance.user.username})`, "plugin")
                    await sendBlockLog(instance.user, "Unknown game", `Ticket: \`${optionId}\`\nEntered: \`${gameName}\`\nAllowed: ${cfg.availableGames.map(g => `\`${g}\``).join(", ")}`)
                    return
                }
                if (isGameDisabled(gameName, cfg.disabledGames)) {
                    await instance.update({
                        id: new api.ODId("game-guard:disabled-game"), ephemeral: true,
                        message: { embeds: [new discord.EmbedBuilder()
                            .setTitle("🚫 Game Unavailable")
                            .setDescription(
                                `Support for **${gameName}** is currently **unavailable**.\n\n` +
                                `Please try again later or contact an administrator.`
                            )
                            .setColor(0xE74C3C).toJSON()] }
                    })
                    cancel()
                    opendiscord.log(`Game Guard: Blocked ticket \`${optionId}\` — disabled game "${gameName}" (${instance.user.username})`, "plugin")
                    await sendBlockLog(instance.user, "Game disabled", `Ticket: \`${optionId}\`\nGame: \`${gameName}\``)
                    return
                }
            }

            // ── Code check ───────────────────────────────────────────────────
            if (cfg.ticketCode.enabled) {
                const codeAnswer = instance.values.getTextField(CODE_QUESTION_ID, false)
                if (codeAnswer !== null && !isCodeValid(codeAnswer, cfg.ticketCode)) {
                    await instance.update({
                        id: new api.ODId("game-guard:wrong-code"), ephemeral: true,
                        message: { embeds: [new discord.EmbedBuilder()
                            .setTitle("🔒 Wrong Code")
                            .setDescription(
                                `The code you entered (\`${codeAnswer.trim()}\`) is **incorrect**.\n\n` +
                                `Check the code channel and try again.`
                            )
                            .setColor(0xE74C3C).toJSON()] }
                    })
                    cancel()
                    opendiscord.log(`Game Guard: Blocked ticket \`${optionId}\` — wrong code from ${instance.user.username}`, "plugin")
                    await sendBlockLog(instance.user, "Wrong ticket code", `Ticket: \`${optionId}\`\nEntered: \`${codeAnswer.trim()}\``)
                    return
                }
            }
        })
    )
    opendiscord.log("Game Guard: Modal interceptor active", "plugin")
})

// ─── On bot ready: init code message + start rotation timer ──────────────────
opendiscord.events.get("onReadyForUsage").listen(async () => {
    const cfg = loadConfig()

    // Post / refresh the code message if a channel is configured
    if (cfg.ticketCode.channelId) {
        await updateCodeMessage(cfg)
    }

    // Rotate every 20 minutes
    setInterval(async () => {
        await rotateCode()
    }, ROTATE_MS)

    opendiscord.log("Game Guard: Code rotation timer started (every 20 minutes)", "plugin")
})

// ─── On successful ticket creation: rotate the code ──────────────────────────
opendiscord.events.get("afterTicketCreated").listen(async (_ticket, _creator, _channel) => {
    await rotateCode()
})
