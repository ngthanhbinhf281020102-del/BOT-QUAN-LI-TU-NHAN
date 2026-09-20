const { Client, GatewayIntentBits } = require("discord.js");
const { joinVoiceChannel, VoiceConnectionStatus } = require("@discordjs/voice");
const Database = require("better-sqlite3");

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const JAIL_ROLE_ID = process.env.JAIL_ROLE_ID;
const JAIL_LOG_CHANNEL_ID = process.env.JAIL_LOG_CHANNEL_ID;

if (!TOKEN || !GUILD_ID || !CHANNEL_ID || !JAIL_ROLE_ID || !JAIL_LOG_CHANNEL_ID) {
    console.error("❌ Thiếu Railway Variables.");
    process.exit(1);
}

const db = new Database("roles.db");
db.pragma("journal_mode = WAL");

db.prepare(`
CREATE TABLE IF NOT EXISTS saved_roles (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
)`).run();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ]
});

let connection = null;
let reconnectTimer = null;

function joinRoom() {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return console.log("❌ Không tìm thấy server.");

    const channel = guild.channels.cache.get(CHANNEL_ID);
    if (!channel) return console.log("❌ Không tìm thấy phòng thoại.");
    if (!channel.isVoiceBased()) return console.log("❌ CHANNEL_ID không phải phòng thoại.");

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

    console.log(`🎧 Đã vào phòng thoại: ${channel.name}`);

    connection.on(VoiceConnectionStatus.Ready, () => {
        console.log("✅ Voice đã sẵn sàng.");
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log("⚠️ Mất kết nối voice.");

        if (reconnectTimer) clearTimeout(reconnectTimer);

        reconnectTimer = setTimeout(() => {
            console.log("🔄 Đang kết nối lại voice...");
            joinRoom();
        }, 5000);
    });
}

function saveRoles(member) {
    const roles = member.roles.cache
        .filter(r => r.id !== member.guild.id && !r.managed)
        .map(r => r.id);

    db.prepare(`
        INSERT INTO saved_roles
        (guild_id, user_id, role_ids, created_at)
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

    console.log(`💾 Đã lưu ${roles.length} role của ${member.user.tag}.`);
}

async function restoreRoles(member) {
    const row = db.prepare(`
        SELECT role_ids FROM saved_roles
        WHERE guild_id = ? AND user_id = ?
    `).get(member.guild.id, member.id);

    if (!row) return;

    let roleIds;

    try {
        roleIds = JSON.parse(row.role_ids);
    } catch {
        console.error("❌ Dữ liệu role bị lỗi.");
        return;
    }

    const botPosition = member.guild.members.me.roles.highest.position;

    const validRoles = roleIds.filter(roleId => {
        const role = member.guild.roles.cache.get(roleId);

        return role &&
            !role.managed &&
            role.position < botPosition;
    });

    if (validRoles.length) {
        try {
            await member.roles.add(
                validRoles,
                "TB ManagerBot: khôi phục role sau khi hết Tù"
            );

            console.log(
                `♻️ Đã khôi phục ${validRoles.length} role cho ${member.user.tag}.`
            );
        } catch (error) {
            console.error("❌ Lỗi khôi phục role:", error.message);
        }
    }

    db.prepare(`
        DELETE FROM saved_roles
        WHERE guild_id = ? AND user_id = ?
    `).run(member.guild.id, member.id);
}
async function sendJailNotification(member) {
    const channel = member.guild.channels.cache.get(JAIL_LOG_CHANNEL_ID);

    if (!channel) {
        console.log("❌ Không tìm thấy kênh thông báo Tù.");
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

        console.log(`📢 Đã thông báo Tù cho ${member.user.tag}.`);
    } catch (error) {
        console.error("❌ Lỗi gửi thông báo:", error.message);
    }
}

client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const oldJail = oldMember.roles.cache.has(JAIL_ROLE_ID);
    const newJail = newMember.roles.cache.has(JAIL_ROLE_ID);

    if (!oldJail && newJail) {
        console.log(`🔒 ${newMember.user.tag} đã vào Tù.`);

        saveRoles(oldMember);

        const botPosition = newMember.guild.members.me.roles.highest.position;

        const rolesToRemove = newMember.roles.cache.filter(role =>
            role.id !== newMember.guild.id &&
            role.id !== JAIL_ROLE_ID &&
            !role.managed &&
            role.position < botPosition
        );

        if (rolesToRemove.size) {
            try {
                await newMember.roles.remove(
                    rolesToRemove,
                    "TB ManagerBot: đưa thành viên vào Tù"
                );

                console.log(
                    `🔒 Đã xóa ${rolesToRemove.size} role của ${newMember.user.tag}.`
                );
            } catch (error) {
                console.error("❌ Lỗi xóa role:", error.message);
            }
        }

        await sendJailNotification(newMember);
    }

    if (oldJail && !newJail) {
        console.log(`🔓 ${newMember.user.tag} đã hết Tù.`);
        await restoreRoles(newMember);
    }
});

client.once("ready", () => {
    console.log("================================");
    console.log(`🤖 Bot: ${client.user.tag}`);
    console.log("🤖 TB ManagerBot đã online.");
    console.log(`🏠 GUILD_ID: ${GUILD_ID}`);
    console.log(`🎧 CHANNEL_ID: ${CHANNEL_ID}`);
    console.log(`🔒 JAIL_ROLE_ID: ${JAIL_ROLE_ID}`);
    console.log(`📢 JAIL_LOG_CHANNEL_ID: ${JAIL_LOG_CHANNEL_ID}`);
    console.log("================================");

    joinRoom();
});

client.on("error", error => {
    console.error("❌ Discord Error:", error);
});

process.on("unhandledRejection", error => {
    console.error("❌ Unhandled Rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("❌ Uncaught Exception:", error);
});

client.login(TOKEN);
