import { createContext } from "react";

/**
 * Actions deep message parts need (e.g. the handoff card's "continue").
 * Provided through context so memoized message bubbles don't re-render
 * when `streaming` flips — only the consumers do.
 */
export interface ChatActionsValue {
  send: (text: string) => void;
  streaming: boolean;
}

export const ChatActions = createContext<ChatActionsValue>({
  send: () => {},
  streaming: false
});
