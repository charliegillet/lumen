export type AgentId = 'maya' | 'theo' | 'priya';
export type Effort = 'low' | 'medium' | 'high';
export type EventBody =
  | { type: 'user_message'; messageId: string; clientMsgId: string; text: string }
  | {
      type: 'message_started';
      messageId: string;
      agentId: AgentId;
      turnId: string;
      hop: number;
      replyTo: string | null;
      contextCutoffSeq: number;
      effort: Effort;
    }
  | { type: 'token_delta'; messageId: string; segment: number; offset: number; text: string }
  | {
      type: 'message_segment_started';
      messageId: string;
      segment: number;
      contextCutoffSeq: number;
      truncateTo: number;
      mode: 'continue' | 'replace';
      /** Set when a user steer caused this segment: the message moves below that steer. */
      moved?: boolean;
    }
  | { type: 'message_completed'; messageId: string }
  | {
      type: 'message_aborted';
      messageId: string;
      reason: 'user_stop' | 'error' | 'server_restart';
      truncateTo: number;
    }
  | { type: 'instruction_set'; instructionId: string; scope: AgentId | 'all'; text: string }
  | { type: 'instruction_revoked'; instructionId: string }
  | { type: 'steer_resolved'; userMessageId: string; targets: AgentId[] } // invisible; lets clients unfreeze
  | { type: 'stop_all'; clientReqId: string };
export type ConvEvent = EventBody & { seq: number; conversationId: string; at: number };
