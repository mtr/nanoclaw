import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  API_ENABLED,
  API_PORT,
  ASSISTANT_NAME,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { CliChannel } from './channels/cli.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { createApiServer, saveAudioFile } from './api-server.js';
import { synthesizeSpeech, isTtsEnabled } from './tts.js';
import { recordTtsUsage, checkBudget } from './cost-tracker.js';
import { readEnvFile } from './env.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  archiveThread,
  createThread,
  getActiveThread,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getMessagesSinceInThread,
  getNewMessages,
  getRouterState,
  getThreadBySlug,
  getThreadMessageCount,
  getThreads,
  initDatabase,
  resumeThread,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateThreadName,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  extractSpokenText,
  findChannel,
  formatMessages,
  formatOutbound,
  stripAudioTags,
  stripInternalTags,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  fetchPendingMessagesForScope,
  makeUniqueThreadSlug,
  resolveHandledCommandCursor,
  ThreadCommandResult,
} from './thread-helpers.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();
let pushSseEvent:
  | ((event: string, data: Record<string, unknown>) => void)
  | null = null;

/** Send via the owning channel AND mirror to SSE for TUI consumers. */
async function broadcastMessage(
  channel: Channel,
  jid: string,
  text: string,
): Promise<void> {
  await channel.sendMessage(jid, text);
  if (!jid.startsWith('cli:') && pushSseEvent) {
    pushSseEvent('message', {
      jid,
      content: text,
      audioUrl: null,
      timestamp: new Date().toISOString(),
    });
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

const THREAD_COMMANDS = /^\/(new|reset|threads|resume)\b/;

async function handleThreadCommand(
  chatJid: string,
  content: string,
  channel: Channel,
): Promise<ThreadCommandResult> {
  const match = content.trim().match(THREAD_COMMANDS);
  if (!match) return { handled: false };

  const command = match[1];

  if (command === 'new' || command === 'reset') {
    const now = new Date().toISOString();
    const active = getActiveThread(chatJid);

    if (active) {
      archiveThread(active.id, now);
      logger.info(
        { chatJid, threadId: active.id, threadName: active.name },
        'Thread archived',
      );
    }

    const newId = randomUUID();
    const newSlug = `thread-${Date.now()}`;
    createThread({
      id: newId,
      chat_jid: chatJid,
      name: 'New conversation',
      slug: newSlug,
      created_at: now,
      start_timestamp: now,
    });

    await channel.clearChat?.(chatJid);

    const archivedInfo = active
      ? ` Previous thread "${active.name}" archived.`
      : '';
    await broadcastMessage(
      channel,
      chatJid,
      `Fresh conversation started.${archivedInfo}`,
    );

    return { handled: true, cursorTimestamp: now };
  }

  if (command === 'threads') {
    const threads = getThreads(chatJid);
    if (threads.length === 0) {
      await broadcastMessage(
        channel,
        chatJid,
        'No threads yet. Send /new to start one.',
      );
      return { handled: true };
    }

    const lines = threads.map((t, i) => {
      const status = t.archived_at ? '' : ' (active)';
      const count = getThreadMessageCount(t.id);
      const date = t.created_at.split('T')[0];
      return `${i + 1}. ${t.slug}${status} — "${t.name}" (${date}, ${count} msgs)`;
    });

    await broadcastMessage(channel, chatJid, `Threads:\n${lines.join('\n')}`);
    return { handled: true };
  }

  if (command === 'resume') {
    const slug = content.trim().split(/\s+/)[1];
    if (!slug) {
      await broadcastMessage(channel, chatJid, 'Usage: /resume <slug>');
      return { handled: true };
    }

    const target = getThreadBySlug(chatJid, slug);
    if (!target) {
      await broadcastMessage(
        channel,
        chatJid,
        `Thread "${slug}" not found. Use /threads to list.`,
      );
      return { handled: true };
    }

    if (!target.archived_at) {
      await broadcastMessage(
        channel,
        chatJid,
        `Thread "${slug}" is already active.`,
      );
      return { handled: true };
    }

    const now = new Date().toISOString();
    const active = getActiveThread(chatJid);
    if (active) {
      archiveThread(active.id, now);
    }

    resumeThread(target.id);
    await channel.clearChat?.(chatJid);
    await broadcastMessage(
      channel,
      chatJid,
      `Resumed thread "${target.name}".`,
    );

    return { handled: true, cursorTimestamp: target.start_timestamp };
  }

  return { handled: false };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Handle thread commands before agent processing
  for (const msg of missedMessages) {
    if (THREAD_COMMANDS.test(msg.content.trim())) {
      const result = await handleThreadCommand(chatJid, msg.content, channel);
      if (result.handled) {
        lastAgentTimestamp[chatJid] = resolveHandledCommandCursor(
          msg.timestamp,
          result,
        );
        saveState();
      }
    }
  }

  // Re-fetch messages using thread scope (commands may have changed the active thread)
  const activeThread = getActiveThread(chatJid);
  const threadMessages = activeThread
    ? getMessagesSinceInThread(
        chatJid,
        lastAgentTimestamp[chatJid] || '',
        ASSISTANT_NAME,
        activeThread.id,
      )
    : missedMessages;

  // Filter out thread commands from agent input
  const agentMessages = threadMessages.filter(
    (m) => !THREAD_COMMANDS.test(m.content.trim()),
  );

  if (agentMessages.length === 0) return true;

  // Auto-name thread from first user message
  if (
    activeThread &&
    activeThread.name === 'New conversation' &&
    agentMessages.length > 0
  ) {
    const firstContent = agentMessages[0].content;
    const autoName = firstContent.slice(0, 60).replace(/\n/g, ' ');
    const slug = makeUniqueThreadSlug({
      chatJid,
      baseName: autoName,
      currentThreadId: activeThread.id,
      findBySlug: getThreadBySlug,
    });
    try {
      updateThreadName(activeThread.id, autoName, slug);
    } catch (err) {
      logger.warn(
        { chatJid, threadId: activeThread.id, slug, err },
        'Failed to auto-name active thread',
      );
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = agentMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(agentMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    agentMessages[agentMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: agentMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    activeThread?.id,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip internal reasoning, then extract TTS text and clean display text
        const stripped = stripInternalTags(raw);
        const spokenText = extractSpokenText(stripped);
        const text = stripAudioTags(stripped).trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await broadcastMessage(channel, chatJid, text);
          outputSentToUser = true;
        }
        // TTS: synthesize and send audio if <audio> tags were present
        if (spokenText) {
          try {
            if (isTtsEnabled()) {
              const budget = checkBudget();
              if (budget.ttsAllowed) {
                const result = await synthesizeSpeech(spokenText);
                if (result) {
                  await channel.sendAudio?.(
                    chatJid,
                    result.audio,
                    'audio/ogg; codecs=opus',
                  );
                  const audioId = saveAudioFile(result.audio);
                  recordTtsUsage({
                    characters: result.characterCount,
                    costEstimate: result.characterCount * 0.000015,
                    model: 'gpt-4o-mini-tts',
                  });
                  pushSseEvent?.('audio', {
                    jid: chatJid,
                    audioUrl: `/api/audio/${audioId}`,
                  });
                }
              }
            }
          } catch (err) {
            logger.error({ err }, 'TTS processing failed');
          }
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  threadId?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = threadId ? sessions[threadId] : undefined;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && threadId) {
          sessions[threadId] = output.newSessionId;
          setSession(threadId, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId && threadId) {
      sessions[threadId] = output.newSessionId;
      setSession(threadId, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // Intercept thread commands before piping to container
          for (const msg of groupMessages) {
            if (THREAD_COMMANDS.test(msg.content.trim())) {
              const result = await handleThreadCommand(
                chatJid,
                msg.content,
                channel,
              );
              if (result.handled) {
                lastAgentTimestamp[chatJid] = resolveHandledCommandCursor(
                  msg.timestamp,
                  result,
                );
                saveState();
              }
            }
          }

          // Filter out thread commands from messages to pipe
          const nonCommandMessages = groupMessages.filter(
            (m) => !THREAD_COMMANDS.test(m.content.trim()),
          );
          if (nonCommandMessages.length === 0) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = nonCommandMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const activeThread = getActiveThread(chatJid);
          const allPending = fetchPendingMessagesForScope({
            chatJid,
            sinceTimestamp: lastAgentTimestamp[chatJid] || '',
            assistantName: ASSISTANT_NAME,
            activeThreadId: activeThread?.id,
            getMessagesSince,
            getMessagesSinceInThread,
          });
          const messagesToSend =
            allPending.length > 0
              ? allPending.filter(
                  (m) => !THREAD_COMMANDS.test(m.content.trim()),
                )
              : nonCommandMessages;
          if (messagesToSend.length === 0) continue;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDefaultThreads(): void {
  for (const chatJid of Object.keys(registeredGroups)) {
    const active = getActiveThread(chatJid);
    if (!active) {
      const id = randomUUID();
      const now = new Date().toISOString();
      createThread({
        id,
        chat_jid: chatJid,
        name: 'Default',
        slug: 'default',
        created_at: now,
        start_timestamp: '',
      });
      logger.info({ chatJid }, 'Created default thread for group');
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  ensureDefaultThreads();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();

  // CLI channel
  const cliChannel = new CliChannel(channelOpts);
  channels.push(cliChannel);
  await cliChannel.connect();

  // HTTP API server
  if (API_ENABLED) {
    const env = readEnvFile(['NANOCLAW_API_KEY']);
    const apiKey = env.NANOCLAW_API_KEY;
    if (apiKey) {
      const api = createApiServer({
        apiKey,
        cliChannel,
        getGroups: () => registeredGroups,
        getHistory: (jid, limit) => {
          const messages = getMessagesSince(
            jid,
            new Date(0).toISOString(),
            ASSISTANT_NAME,
          );
          return limit ? messages.slice(-limit) : messages;
        },
      });
      pushSseEvent = api.pushSseEvent;
      api.server.on('error', (err) => {
        logger.error(
          { err, port: API_PORT },
          'HTTP API server failed to start',
        );
      });
      api.server.listen(API_PORT, '127.0.0.1', () => {
        logger.info({ port: API_PORT }, 'HTTP API server listening');
      });
    } else {
      logger.info('NANOCLAW_API_KEY not set — HTTP API disabled');
    }
  }

  // Wire CLI outbound handler — just push SSE text events.
  // TTS synthesis is handled centrally in the streaming callback.
  cliChannel.setOutboundHandler((jid, text) => {
    pushSseEvent?.('message', {
      jid,
      content: text,
      audioUrl: null,
      timestamp: new Date().toISOString(),
    });
  });

  // Pre-register CLI group
  if (!registeredGroups['cli:main']) {
    const cliGroup = {
      name: 'CLI',
      folder: 'cli',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    setRegisteredGroup('cli:main', cliGroup);
    registeredGroups['cli:main'] = cliGroup;
    fs.mkdirSync(path.join(GROUPS_DIR, 'cli', 'logs'), { recursive: true });
  }
  // Ensure CLI chat exists in the chats table (idempotent upsert)
  storeChatMetadata('cli:main', new Date().toISOString(), 'CLI', 'cli', false);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await broadcastMessage(channel, jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return broadcastMessage(channel, jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) =>
      whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

/** @internal Test-only setter for pushSseEvent */
export function _setPushSseEvent(
  fn: ((event: string, data: Record<string, unknown>) => void) | null,
): void {
  pushSseEvent = fn;
}

/** @internal Test-only access to broadcastMessage */
export const _broadcastMessage = broadcastMessage;

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
