import { createContext } from "react";
import type { SourceItem } from "./types";

/**
 * Actions deep message parts need (handoff "continue", message actions,
 * MCP app `ui/message`). Provided through context so memoized message
 * bubbles don't re-render when `streaming` flips — only the consumers do.
 */
export interface ChatActionsValue {
  send: (text: string) => void;
  streaming: boolean;
  /** stop the in-flight run */
  stop: () => void;
  /** drop the last user+assistant pair and resend that user text */
  regenerate: () => void;
  /** truncate from a user message and resend it with new text */
  edit: (messageId: string, text: string) => void;
}

export const ChatActions = createContext<ChatActionsValue>({
  send: () => {},
  streaming: false,
  stop: () => {},
  regenerate: () => {},
  edit: () => {}
});

/** sources of the reply being rendered — read by inline `[n]` citation pills */
export const MessageSources = createContext<SourceItem[] | undefined>(undefined);

/** DOM event: composer asks the list to edit the last user message (↑ in empty composer) */
export const EDIT_LAST_EVENT = "bloop:edit-last";
