/**
 * TEST STUB - NOT INSTALLED INTO NANOCLAW.
 *
 * The subset of NanoClaw v2.3.0 `src/channels/adapter.ts` that the Contro1
 * channel uses, copied signature-for-signature so the connector type-checks and
 * tests without a NanoClaw checkout. The add-contro1 skill copies only
 * contro1.ts and contro1-governance.ts; inside NanoClaw these imports resolve
 * to the real contract.
 */

export interface ChannelSetup {
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: unknown): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;
}

export interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown;
  timestamp: string;
  isMention?: boolean;
  isGroup?: boolean;
}

export interface OutboundFile {
  filename: string;
  data: Buffer;
}

export interface OutboundMessage {
  kind: string;
  content: unknown;
  files?: OutboundFile[];
}

export interface ChannelContextDefaults {
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  engagePattern?: string;
  threads: boolean;
  sessionMode?: 'shared' | 'per-thread';
  unknownSenderPolicy: 'strict' | 'request_approval' | 'decline_notify' | 'public';
}

export interface ChannelDefaults {
  dm: ChannelContextDefaults;
  group: ChannelContextDefaults;
  mentions: 'platform' | 'dm-only' | 'never';
}

export interface ChannelAdapter {
  name: string;
  channelType: string;
  instance?: string;
  supportsThreads: boolean;
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;
  openDM?(userHandle: string): Promise<string>;
  defaults?: ChannelDefaults;
}

export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;

export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  defaults?: ChannelDefaults;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
