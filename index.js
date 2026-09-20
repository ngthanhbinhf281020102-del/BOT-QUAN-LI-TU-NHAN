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

// ================================
// KIỂM TRA VARIABLES
// ================================

if (!TOKEN) {
    console.error("❌ Thiếu TOKEN trên Railway Variables.");
    process.exit(1);
}

if (!GUILD_ID) {
    console.error("❌ Thiếu GUILD_ID trên Railway Variables.");
    process.exit(1);
}

if (!CHANNEL_ID) {
    console.error("❌ Thiếu CHANNEL_ID trên Railway Variables.");
    process.exit(1);
}

if (!JAIL_ROLE_ID) {
    console.error("❌ Thiếu JAIL_ROLE_ID trên Railway Variables.");
    process.exit(1);
}

// ================================
// DATABASE SQLITE
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
    const guild = client.guilds.cache.get(GUILD_ID);

    if (!guild) {
        console.log("❌ Không tìm thấy server.");
        return;
    }

    const channel = guild.channels.cache.get(CHANNEL_ID);

    if (!channel) {
        console.log("❌ Không tìm thấy phòng thoại.");
        return;
    }

    if (!channel.isVoiceBased()) {
        console.log("❌ CHANNEL_ID không phải phòng thoại.");
        return;
    }

    if (connection) {
        try {
            connection.destroy();
        } catch (error) {
            console.log("⚠️ Không thể destroy connection cũ.");
        }

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

    connection.on(
        VoiceConnectionStatus.Ready,
        () => {
            console.log("✅ Voice connection đã sẵn sàng.");
        }
    );

    connection.on(
        VoiceConnectionStatus.Disconnected,
        () => {
            console.log("⚠️ Mất kết nối voice.");

            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }

            reconnectTimer = setTimeout(() => {
                console.log("🔄 Đang thử kết nối lại voice...");
                joinRoom();
            }, 5000);
        }
    );

    connection.on(
        VoiceConnectionStatus.Destroyed,
        () => {
            console.log("⚠️ Voice connection đã bị hủy.");
        }
    );
}

// ================================
// LƯU ROLE
// ================================

function saveRoles(member) {
    const roles = member.roles.cache
        .filter(role => role.id !== member.guild.id)
        .filter(role => !role.managed)
        .map(role => role.id);

    const roleData = JSON.stringify(roles);

    db.prepare(`
        INSERT INTO saved_roles (
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
        roleData,
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
    const row = db.prepare(`
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
            `ℹ️ Không có role được lưu cho ${member.user.tag}.`
        );
        return;
    }

    let roleIds;

    try {
        roleIds = JSON.parse(row.role_ids);
    } catch (error) {
        console.error("❌ Dữ liệu role trong SQLite bị lỗi.");
        return;
    }

    const validRoleIds = [];

    for (const roleId of roleIds) {
        const role = member.guild.roles.cache.get(roleId);

        if (!role) {
            console.log(
                `⚠️ Role ${roleId} không còn tồn tại.`
            );
            continue;
        }

        if (role.managed) {
            continue;
        }

        if (role.position >= member.guild.members.me.roles.highest.position) {
            console.log(
                `⚠️ Không thể khôi phục role ${role.name} vì role bot không đủ cao.`
            );
            continue;
        }

        validRoleIds.push(role.id);
    }

    if (validRoleIds.length > 0) {
        try {
            await member.roles.add(
                validRoleIds,
                "TB ManagerBot: khôi phục role sau khi hết Tù"
            );

            console.log(
                `♻️ Đã khôi phục ${validRoleIds.length} role cho ${member.user.tag}.`
            );
        } catch (error) {
            console.error(
                `❌ Lỗi khôi phục role cho ${member.user.tag}:`,
                error.message
            );
        }
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
// XỬ LÝ THAY ĐỔI ROLE
// ================================

client.on(
    "guildMemberUpdate",
    async (oldMember, newMember) => {

        const oldHasJail = oldMember.roles.cache.has(JAIL_ROLE_ID);
        const newHasJail = newMember.roles.cache.has(JAIL_ROLE_ID);

        // ============================
        // THÊM ROLE TÙ
        // ============================

        if (!oldHasJail && newHasJail) {

            console.log(
                `🔒 ${newMember.user.tag} đã bị thêm role Tù.`
            );

            // Lưu role cũ trước
            saveRoles(oldMember);

            // Lấy tất cả role cần xóa
            const rolesToRemove = newMember.roles.cache
                .filter(role => role.id !== newMember.guild.id)
                .filter(role => role.id !== JAIL_ROLE_ID)
                .filter(role => !role.managed)
                .filter(
                    role =>
                        role.position <
                        newMember.guild.members.me.roles.highest.position
                );

            if (rolesToRemove.size > 0) {
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
        }

        // ============================
        // GỠ ROLE TÙ
        // ============================

        if (oldHasJail && !newHasJail) {

            console.log(
                `🔓 ${newMember.user.tag} đã hết Tù.`
            );

            await restoreRoles(newMember);
        }
    }
);

// ================================
// BOT READY
// ================================

client.once("ready", async () => {

    console.log("================================");
    console.log(`🤖 Bot: ${client.user.tag}`);
    console.log("🤖 TB ManagerBot đã online.");
    console.log(`🏠 GUILD_ID: ${GUILD_ID}`);
    console.log(`🎧 CHANNEL_ID: ${CHANNEL_ID}`);
    console.log(`🔒 JAIL_ROLE_ID: ${JAIL_ROLE_ID}`);
    console.log("================================");

    joinRoom();
});

// ================================
// XỬ LÝ LỖI
// ================================

client.on("error", error => {
    console.error("❌ Discord Client Error:", error);
});

process.on("unhandledRejection", error => {
    console.error("❌ Unhandled Rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("❌ Uncaught Exception:", error);
});

// ================================
// LOGIN
// ================================

client.login(TOKEN);