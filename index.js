const {
    Client,
    GatewayIntentBits
} = require("discord.js");

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const Database = require("better-sqlite3");

// ================================
// CẤU HÌNH
// ================================

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const JAIL_ROLE_ID = process.env.JAIL_ROLE_ID;
const JAIL_LOG_CHANNEL_ID = process.env.JAIL_LOG_CHANNEL_ID;

// ================================
// KIỂM TRA VARIABLES
// ================================

if (
    !TOKEN ||
    !GUILD_ID ||
    !CHANNEL_ID ||
    !JAIL_ROLE_ID ||
    !JAIL_LOG_CHANNEL_ID
) {
    console.error("❌ Thiếu Railway Variables.");
    process.exit(1);
}

// ================================
// SQLITE
// ================================

const db = new Database("roles.db");

db.pragma("journal_mode = WAL");

db.prepare(`
CREATE TABLE IF NOT EXISTS saved_roles (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
)
`).run();

console.log("✅ SQLite database đã sẵn sàng.");

// ================================
// DISCORD CLIENT
// ================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ================================
// VOICE
// ================================

let connection = null;
let reconnectTimer = null;

function joinRoom() {

    const guild =
        client.guilds.cache.get(GUILD_ID);

    if (!guild) {
        console.log(
            "❌ Không tìm thấy server."
        );
        return;
    }

    const channel =
        guild.channels.cache.get(CHANNEL_ID);

    if (!channel) {
        console.log(
            "❌ Không tìm thấy phòng thoại."
        );
        return;
    }

    if (!channel.isVoiceBased()) {
        console.log(
            "❌ CHANNEL_ID không phải phòng thoại."
        );
        return;
    }

    if (connection) {

        try {
            connection.destroy();
        } catch {}

        connection = null;
    }

    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
    });

    console.log(
        `🎧 Đã vào phòng thoại: ${channel.name}`
    );

    connection.on(
        VoiceConnectionStatus.Ready,
        () => {

            console.log(
                "✅ Voice đã sẵn sàng."
            );

        }
    );

    connection.on(
        VoiceConnectionStatus.Disconnected,
        () => {

            console.log(
                "⚠️ Mất kết nối voice."
            );

            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }

            reconnectTimer = setTimeout(
                () => {

                    console.log(
                        "🔄 Đang kết nối lại voice..."
                    );

                    joinRoom();

                },
                5000
            );

        }
    );
}

// ================================
// LƯU ROLE
// ================================

function saveRoles(member) {

    const roles =
        member.roles.cache
            .filter(role =>
                role.id !== member.guild.id &&
                !role.managed
            )
            .map(role => role.id);

    db.prepare(`
        INSERT INTO saved_roles
        (
            guild_id,
            user_id,
            role_ids,
            created_at
        )
        VALUES (?, ?, ?, ?)

        ON CONFLICT(guild_id, user_id)
        DO UPDATE SET
            role_ids = excluded.role_ids,
            created_at = excluded.created_at
    `).run(
        member.guild.id,
        member.id,
        JSON.stringify(roles),
        Date.now()
    );

    console.log(
        `💾 Đã lưu ${roles.length} role của ${member.user.tag}.`
    );
}

// ================================
// KHÔI PHỤC ROLE
// ================================

async function restoreRoles(member) {

    const row =
        db.prepare(`
            SELECT role_ids
            FROM saved_roles
            WHERE guild_id = ?
            AND user_id = ?
        `).get(
            member.guild.id,
            member.id
        );

    if (!row) {

        console.log(
            `ℹ️ Không có role đã lưu cho ${member.user.tag}.`
        );

        return;
    }

    let roleIds;

    try {

        roleIds =
            JSON.parse(row.role_ids);

    } catch {

        console.error(
            "❌ Dữ liệu role bị lỗi."
        );

        return;
    }

    const botMember =
        member.guild.members.me;

    if (!botMember) {

        console.error(
            "❌ Không lấy được thông tin role của bot."
        );

        return;
    }

    const botPosition =
        botMember.roles.highest.position;

    const validRoles =
        roleIds.filter(roleId => {

            const role =
                member.guild.roles.cache.get(
                    roleId
                );

            return (
                role &&
                !role.managed &&
                role.position < botPosition
            );

        });

    if (validRoles.length > 0) {

        try {

            await member.roles.add(
                validRoles,
                "TB ManagerBot: khôi phục role sau khi hết Tù"
            );

            console.log(
                `♻️ Đã khôi phục ${validRoles.length} role cho ${member.user.tag}.`
            );

        } catch (error) {

            console.error(
                "❌ Lỗi khôi phục role:",
                error.message
            );

        }

    } else {

        console.log(
            `ℹ️ Không có role hợp lệ để khôi phục cho ${member.user.tag}.`
        );

    }

    db.prepare(`
        DELETE FROM saved_roles
        WHERE guild_id = ?
        AND user_id = ?
    `).run(
        member.guild.id,
        member.id
    );
}

// ================================
// CHỐNG THÔNG BÁO TÙ TRÙNG
// ================================

const jailNotificationCooldown =
    new Set();

// ================================
// THÔNG BÁO VÀO TÙ
// ================================

async function sendJailNotification(member) {

    // Nếu người này vừa được thông báo
    // thì bỏ qua thông báo trùng trong 2 giây
    if (
        jailNotificationCooldown.has(
            member.id
        )
    ) {

        console.log(
            `⚠️ Bỏ qua thông báo Tù trùng cho ${member.user.tag}.`
        );

        return;
    }

    jailNotificationCooldown.add(
        member.id
    );

    setTimeout(
        () => {

            jailNotificationCooldown.delete(
                member.id
            );

        },
        2000
    );

    const channel =
        member.guild.channels.cache.get(
            JAIL_LOG_CHANNEL_ID
        );

    if (!channel) {

        console.log(
            "❌ Không tìm thấy kênh thông báo Tù."
        );

        return;
    }

    if (!channel.isTextBased()) {

        console.log(
            "❌ JAIL_LOG_CHANNEL_ID không phải kênh văn bản."
        );

        return;
    }

    try {

        await channel.send(
`╔══════════════════════╗
   📢 **THÔNG BÁO**   
╚══════════════════════╝

🚨 **${member} đã bị cấm và vào tù!** 🚨

🔒 **Trạng thái:** Đang chấp hành hình phạt
⏳ Hãy chờ hết thời gian phạt để được **ra tù!**

╰┈➤ 🔔 Vui lòng tuân thủ nội quy máy chủ.`
        );

        console.log(
            `📢 Đã thông báo Tù cho ${member.user.tag}.`
        );

    } catch (error) {

        console.error(
            "❌ Lỗi gửi thông báo:",
            error.message
        );

    }
}

// ================================
// THEO DÕI ROLE TÙ
// ================================

client.on(
    "guildMemberUpdate",
    async (oldMember, newMember) => {

        const oldJail =
            oldMember.roles.cache.has(
                JAIL_ROLE_ID
            );

        const newJail =
            newMember.roles.cache.has(
                JAIL_ROLE_ID
            );

        // ==========================
        // VÀO TÙ
        // ==========================

        if (
            !oldJail &&
            newJail
        ) {

            console.log(
                `🔒 ${newMember.user.tag} đã vào Tù.`
            );

            // Lưu role cũ
            saveRoles(oldMember);

            const botMember =
                newMember.guild.members.me;

            if (!botMember) {

                console.error(
                    "❌ Không lấy được thông tin role của bot."
                );

                return;
            }

            const botPosition =
                botMember.roles.highest.position;

            const rolesToRemove =
                newMember.roles.cache.filter(
                    role =>
                        role.id !== newMember.guild.id &&
                        role.id !== JAIL_ROLE_ID &&
                        !role.managed &&
                        role.position < botPosition
                );

            if (
                rolesToRemove.size > 0
            ) {

                try {

                    await newMember.roles.remove(
                        rolesToRemove,
                        "TB ManagerBot: đưa thành viên vào Tù"
                    );

                    console.log(
                        `🔒 Đã xóa ${rolesToRemove.size} role của ${newMember.user.tag}.`
                    );

                } catch (error) {

                    console.error(
                        "❌ Lỗi xóa role:",
                        error.message
                    );

                }
            }

            // Gửi thông báo
            await sendJailNotification(
                newMember
            );
        }

        // ==========================
        // RA TÙ
        // ==========================

        if (
            oldJail &&
            !newJail
        ) {

            console.log(
                `
