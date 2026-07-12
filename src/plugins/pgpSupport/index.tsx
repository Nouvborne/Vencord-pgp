/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BadgePosition, BadgeUserArgs, ProfileBadge } from "@api/Badges";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings, SettingsStore } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { Logger } from "@utils/Logger";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, DraftType, MessageStore, React, SelectedChannelStore, showToast, TextArea, TextInput, Toasts, Tooltip, UploadHandler, useEffect, UserStore, useState } from "@webpack/common";
import * as openpgp from "openpgp";

const PGP_PREFIX = "VC_PGP:";
const PGP_FILE_PREFIX = "pgp-message-";
const DISCORD_FREE_MESSAGE_LIMIT = 1999;
const logger = new Logger("PgpSupport");
const publicKeyCache = new Map<string, string | null>();
const decryptedMessages = new Map<string, { channelId: string; messageId: string; encryptedContent: string; }>();

let pgpEnabled = false;
let refreshChatButton: (() => void) | undefined;

const TextAreaComponent = TextArea as any;
const TextInputComponent = TextInput as any;

const settings = definePluginSettings({
    backendUrl: {
        type: OptionType.STRING,
        description: "PGP key backend URL",
        default: "https://pgp.nitera.cc"
    },
    enabledByDefault: {
        type: OptionType.BOOLEAN,
        description: "Keep PGP enabled when changing channels",
        default: false
    },
    showMessageBadge: {
        type: OptionType.BOOLEAN,
        description: "Show a PGP badge next to registered users in chat",
        default: true
    },
    showProfileBadge: {
        type: OptionType.BOOLEAN,
        description: "Show a PGP badge on registered users' profiles",
        default: true
    },
    keyManager: {
        type: OptionType.COMPONENT,
        component: KeyManager
    },
    privateKey: {
        type: OptionType.CUSTOM,
        default: "",
        hidden: true
    },
    privateKeyPassphrase: {
        type: OptionType.CUSTOM,
        default: "",
        hidden: true
    },
    publicKey: {
        type: OptionType.CUSTOM,
        default: "",
        hidden: true
    }
}).withPrivateSettings<{
    privateKey: string;
    privateKeyPassphrase: string;
    publicKey: string;
}>();

function getBackendUrl() {
    return settings.store.backendUrl.replace(/\/+$/, "");
}

function showPgpToast(message: string, type = Toasts.Type.MESSAGE) {
    showToast(message, type);
}

function encodeArmored(armored: string) {
    return PGP_PREFIX + btoa(armored);
}

function decodeArmored(content: string) {
    if (!content.startsWith(PGP_PREFIX)) return null;

    try {
        return atob(content.slice(PGP_PREFIX.length));
    } catch {
        return null;
    }
}

function getPgpAttachment(message: Message) {
    return (message.attachments as any[] | undefined)?.find(attachment =>
        typeof attachment?.filename === "string"
        && attachment.filename.startsWith(PGP_FILE_PREFIX)
        && attachment.filename.endsWith(".txt")
        && typeof attachment.url === "string"
    );
}

function getCurrentUserId() {
    return UserStore.getCurrentUser()?.id as string | undefined;
}

function isPrivatePgpChannel(channel: any) {
    if (!channel || channel.guild_id) return false;

    return Boolean(
        channel.isDM?.()
        || channel.isGroupDM?.()
        || channel.isMultiUserDM?.()
        || channel.rawRecipients?.length
        || channel.recipients?.length
    );
}

async function getPrivateKey() {
    if (!settings.store.privateKey) return null;

    const privateKey = await openpgp.readPrivateKey({ armoredKey: settings.store.privateKey });
    if (!privateKey.isDecrypted()) {
        return openpgp.decryptKey({
            privateKey,
            passphrase: settings.store.privateKeyPassphrase
        });
    }

    return privateKey;
}

async function publicKeyFromPrivateKey(privateKeyArmored: string) {
    const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
    return privateKey.toPublic().armor();
}

async function getPublicKey(userId: string) {
    if (publicKeyCache.has(userId)) return publicKeyCache.get(userId) ?? null;

    try {
        const response = await fetch(`${getBackendUrl()}/keys/${encodeURIComponent(userId)}`);
        if (response.status === 404) {
            publicKeyCache.set(userId, null);
            return null;
        }
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

        const data = await response.json();
        const publicKey = typeof data.publicKey === "string" ? data.publicKey : null;
        publicKeyCache.set(userId, publicKey);
        return publicKey;
    } catch (e) {
        logger.error("Failed to fetch public key", e);
        return null;
    }
}

function usePgpRegistered(userId: string | undefined) {
    const [registered, setRegistered] = useState(() => userId ? publicKeyCache.get(userId) != null : false);

    useEffect(() => {
        let cancelled = false;

        async function checkUser() {
            if (!userId) {
                setRegistered(false);
                return;
            }

            const publicKey = await getPublicKey(userId);
            if (!cancelled) setRegistered(Boolean(publicKey));
        }

        void checkUser();
        return () => {
            cancelled = true;
        };
    }, [userId, settings.store.backendUrl]);

    return registered;
}

async function bulkGetPublicKeys(userIds: string[]) {
    const missing = userIds.filter(userId => !publicKeyCache.has(userId));
    if (!missing.length) {
        return new Map(userIds.map(userId => [userId, publicKeyCache.get(userId) ?? null]));
    }

    try {
        const response = await fetch(`${getBackendUrl()}/keys/bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ discordIds: missing })
        });

        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = await response.json();
        const keys = data.keys as Record<string, string | null>;

        for (const userId of missing) {
            publicKeyCache.set(userId, typeof keys?.[userId] === "string" ? keys[userId] : null);
        }
    } catch (e) {
        logger.error("Failed to fetch public keys", e);
        for (const userId of missing) publicKeyCache.set(userId, null);
    }

    return new Map(userIds.map(userId => [userId, publicKeyCache.get(userId) ?? null]));
}

async function registerOwnPublicKey(publicKey = settings.store.publicKey) {
    const discordId = getCurrentUserId();
    if (!discordId) throw new Error("Discord user is not available yet");
    if (!publicKey) throw new Error("No public key is configured");

    const response = await fetch(`${getBackendUrl()}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId, publicKey })
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    publicKeyCache.set(discordId, publicKey);
}

function getChannelRecipientIds(channel: any) {
    const currentUserId = getCurrentUserId();
    const ids = new Set<string>();

    for (const recipient of channel?.rawRecipients ?? []) {
        if (recipient?.id) ids.add(recipient.id);
    }

    for (const recipient of channel?.recipients ?? []) {
        if (typeof recipient === "string") ids.add(recipient);
        else if (recipient?.id) ids.add(recipient.id);
    }

    if (currentUserId) ids.delete(currentUserId);
    return [...ids];
}

async function getChannelKeyStatus(channel: any) {
    if (!isPrivatePgpChannel(channel)) {
        return { keys: [], missing: [], total: 0 };
    }

    const recipientIds = getChannelRecipientIds(channel);
    const currentUserId = getCurrentUserId();
    const participantIds = currentUserId
        ? [...new Set([...recipientIds, currentUserId])]
        : recipientIds;
    const keys = await bulkGetPublicKeys(participantIds);
    const missing = participantIds.filter(userId => !keys.get(userId));

    return {
        keys: [...keys.values()].filter((key): key is string => Boolean(key)),
        missing,
        total: participantIds.length
    };
}

async function encryptContent(content: string, publicKeys: string[]) {
    const encryptionKeys = await Promise.all(publicKeys.map(armoredKey => openpgp.readKey({ armoredKey })));
    const message = await openpgp.createMessage({ text: content });
    const encrypted = await openpgp.encrypt({ message, encryptionKeys });

    return encodeArmored(encrypted);
}

async function decryptContent(content: string) {
    const armoredMessage = decodeArmored(content);
    if (!armoredMessage) return null;

    const decryptionKeys = await getPrivateKey();
    if (!decryptionKeys) return null;

    const message = await openpgp.readMessage({ armoredMessage });
    const { data } = await openpgp.decrypt({ message, decryptionKeys });

    return typeof data === "string" ? data : null;
}

async function decryptAndReplaceMessage(message: Message) {
    if (!pgpEnabled) return;
    if (!isPrivatePgpChannel(ChannelStore.getChannel(message.channel_id))) return;

    const key = `${message.channel_id}:${message.id}`;
    if (decryptedMessages.has(key)) return;

    try {
        const pgpAttachment = message?.content?.startsWith(PGP_PREFIX)
            ? null
            : getPgpAttachment(message);
        const encryptedContent = pgpAttachment
            ? await fetch(pgpAttachment.url).then(response => response.ok ? response.text() : null)
            : message.content;

        if (!encryptedContent?.startsWith(PGP_PREFIX)) return;

        const decrypted = await decryptContent(encryptedContent);
        if (!decrypted || !pgpEnabled) return;

        decryptedMessages.set(key, {
            channelId: message.channel_id,
            messageId: message.id,
            encryptedContent: message.content
        });
        updateMessage(message.channel_id, message.id, { content: decrypted });
    } catch (e) {
        logger.error("Failed to decrypt message", e);
    }
}

function restoreDecryptedMessages() {
    for (const [key, entry] of decryptedMessages) {
        updateMessage(entry.channelId, entry.messageId, { content: entry.encryptedContent });
        decryptedMessages.delete(key);
    }
}

function decryptVisibleMessages() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;
    if (!isPrivatePgpChannel(ChannelStore.getChannel(channelId))) return;

    const messages = MessageStore.getMessages(channelId)?._array as Message[] | undefined;
    messages?.forEach(message => void decryptAndReplaceMessage(message));
}

function setPgpEnabled(value: boolean) {
    pgpEnabled = value;

    if (settings.store.enabledByDefault) {
        lastEnabledByDefaultState = value;
    }

    if (value) decryptVisibleMessages();
    else restoreDecryptedMessages();

    refreshChatButton?.();
}

let lastEnabledByDefaultState = false;

const PgpIcon: IconComponent = ({ height = 20, width = 20, className, children }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className}>
        <path fill="currentColor" d="M17 9h-1V7A4 4 0 0 0 8 7v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V7Zm3 9.73V18h-2v-1.27a2 2 0 1 1 2 0Z" />
        {children}
    </svg>
);

function PgpDisabledIcon() {
    return (
        <PgpIcon>
            <path stroke="var(--status-danger)" strokeWidth="2.4" strokeLinecap="round" d="M4 20 20 4" />
        </PgpIcon>
    );
}

function PgpRegisteredBadge({ userId, small = false }: { userId?: string; small?: boolean; }) {
    const registered = usePgpRegistered(userId);
    if (!registered) return null;

    return (
        <Tooltip text="Uses PGP">
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    style={{
                        color: "var(--text-feedback-positive)",
                        display: "inline-flex",
                        height: small ? 16 : 20,
                        marginLeft: small ? 2 : 0,
                        verticalAlign: "middle"
                    }}
                >
                    <PgpIcon height={small ? 14 : 18} width={small ? 14 : 18} />
                </span>
            )}
        </Tooltip>
    );
}

const profileBadge: ProfileBadge = {
    id: "vc_pgp_support_badge",
    key: "PGP",
    description: "Uses PGP",
    position: BadgePosition.START,
    component: ({ userId }: BadgeUserArgs) => settings.store.showProfileBadge
        ? <PgpRegisteredBadge userId={userId} />
        : null
};

const PgpChatButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const [, forceUpdate] = useState({});
    const [availableKeys, setAvailableKeys] = useState(0);
    const hasPrivateKey = Boolean(settings.store.privateKey);

    refreshChatButton = () => forceUpdate({});

    useEffect(() => {
        let cancelled = false;

        async function checkRecipients() {
            const status = await getChannelKeyStatus(channel);
            if (!cancelled) setAvailableKeys(status.missing.length ? 0 : status.keys.length);
        }

        void checkRecipients();
        return () => {
            cancelled = true;
        };
    }, [channel?.id, settings.store.backendUrl]);

    if (!isMainChat || !isPrivatePgpChannel(channel)) return null;

    const canEncrypt = hasPrivateKey && availableKeys > 1;
    const tooltip = pgpEnabled
        ? "Disable PGP"
        : canEncrypt
            ? "Enable PGP"
            : "PGP unavailable in this chat";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => {
                if (!pgpEnabled && !canEncrypt) {
                    showPgpToast(hasPrivateKey ? "Every DM participant must have a registered PGP key" : "Add or generate a PGP key in plugin settings", Toasts.Type.FAILURE);
                    return;
                }

                setPgpEnabled(!pgpEnabled);
            }}
            buttonProps={{ style: { color: pgpEnabled ? "var(--text-feedback-positive)" : undefined } }}
        >
            {pgpEnabled ? <PgpIcon /> : <PgpDisabledIcon />}
        </ChatBarButton>
    );
};

function PgpMessageBadge({ message }: { message: Message; }) {
    if (!settings.store.showMessageBadge) return null;
    if (message.author?.bot || message.author?.system) return null;

    return <PgpRegisteredBadge userId={message.author?.id} small />;
}

function KeyManager() {
    const { privateKey, privateKeyPassphrase, publicKey } = settings.use(["privateKey", "privateKeyPassphrase", "publicKey"]);
    const [busy, setBusy] = useState(false);

    async function run(label: string, action: () => Promise<void>) {
        setBusy(true);
        try {
            await action();
            showPgpToast(label, Toasts.Type.SUCCESS);
        } catch (e) {
            logger.error(label, e);
            showPgpToast(e instanceof Error ? e.message : String(e), Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Flex flexDirection="column" style={{ gap: "0.75em" }}>
            <div>
                <Span weight="medium">Private key</Span>
                <TextAreaComponent
                    value={privateKey}
                    onChange={(value: string) => {
                        settings.store.privateKey = value;
                        settings.store.publicKey = "";
                    }}
                    placeholder="Paste your ASCII-armored private key"
                    rows={8}
                    spellCheck={false}
                />
            </div>

            <div>
                <Span weight="medium">Private key passphrase</Span>
                <TextInputComponent
                    value={privateKeyPassphrase}
                    onChange={(value: string) => settings.store.privateKeyPassphrase = value}
                    placeholder="Required only for encrypted private keys"
                    type="password"
                    spellCheck={false}
                />
            </div>

            {publicKey ? <Paragraph>Public key ready for registration.</Paragraph> : null}

            <Flex style={{ gap: "0.5em", flexWrap: "wrap" }}>
                <Button
                    disabled={busy}
                    onClick={() => run("Generated and registered PGP key", async () => {
                        const user = UserStore.getCurrentUser();
                        if (!user) throw new Error("Discord user is not available yet");

                        const key = await openpgp.generateKey({
                            type: "ecc",
                            curve: "curve25519Legacy",
                            userIDs: [{ name: user.username, email: `${user.id}@discord.local` }]
                        });

                        settings.store.privateKey = key.privateKey;
                        settings.store.publicKey = key.publicKey;
                        await registerOwnPublicKey(key.publicKey);
                        SettingsStore.markAsChanged();
                    })}
                >
                    Generate Key
                </Button>
                <Button
                    disabled={busy || !privateKey}
                    onClick={() => run("Registered PGP public key", async () => {
                        const derivedPublicKey = await publicKeyFromPrivateKey(settings.store.privateKey);
                        settings.store.publicKey = derivedPublicKey;
                        await registerOwnPublicKey(derivedPublicKey);
                    })}
                >
                    Save Public Key
                </Button>
            </Flex>
        </Flex>
    );
}

export default definePlugin({
    name: "PGP Chat",
    description: "Encrypts and decrypts DM messages with OpenPGP using a small public-key backend.",
    tags: ["Chat", "Privacy"],
    authors: [{ name: "Nouvborne", id: 1385778737819156662n }],
    dependencies: ["MessageUpdaterAPI", "MessageDecorationsAPI"],
    settings,
    userProfileBadge: profileBadge,
    renderMessageDecoration: props => <PgpMessageBadge message={props.message} />,

    start() {
        pgpEnabled = settings.store.enabledByDefault && lastEnabledByDefaultState;
    },

    stop() {
        pgpEnabled = false;
        restoreDecryptedMessages();
    },

    chatBarButton: {
        icon: PgpIcon,
        render: PgpChatButton
    },

    async onBeforeMessageSend(_, message, __, props) {
        if (!pgpEnabled || !message.content || message.content.startsWith(PGP_PREFIX)) return;
        if (!isPrivatePgpChannel(props.channel)) {
            showPgpToast("PGP is only supported in direct messages and group DMs", Toasts.Type.FAILURE);
            setPgpEnabled(false);
            return { cancel: true };
        }

        const keyStatus = await getChannelKeyStatus(props.channel);
        if (keyStatus.total <= 1 || keyStatus.missing.length) {
            showPgpToast("PGP message was not sent: not every participant has a registered public key", Toasts.Type.FAILURE);
            return { cancel: true };
        }

        try {
            const encrypted = await encryptContent(message.content, keyStatus.keys);

            if (encrypted.length > DISCORD_FREE_MESSAGE_LIMIT) {
                const file = new File([encrypted], `pgp-message-${Date.now()}.txt`, { type: "text/plain" });
                UploadHandler.promptToUpload([file], props.channel, DraftType.ChannelMessage);
                showPgpToast("Encrypted message exceeded Discord's text limit, uploading as a .txt file instead", Toasts.Type.SUCCESS);
                return { cancel: true };
            }

            message.content = encrypted;
        } catch (e) {
            logger.error("Failed to encrypt message", e);
            showPgpToast("PGP encryption failed", Toasts.Type.FAILURE);
            return { cancel: true };
        }
    },

    flux: {
        MESSAGE_CREATE({ message }: { message: Message; }) {
            void decryptAndReplaceMessage(message);
        },
        MESSAGE_UPDATE({ message }: { message: Message; }) {
            void decryptAndReplaceMessage(message);
        },
        CHANNEL_SELECT() {
            const channel = ChannelStore.getChannel(SelectedChannelStore.getChannelId());
            if (!isPrivatePgpChannel(channel)) {
                if (pgpEnabled) setPgpEnabled(false);
                refreshChatButton?.();
                return;
            }

            if (settings.store.enabledByDefault) {
                pgpEnabled = lastEnabledByDefaultState;
                refreshChatButton?.();
                if (pgpEnabled) decryptVisibleMessages();
            } else if (pgpEnabled) {
                setPgpEnabled(false);
            }
        }
    }
});
