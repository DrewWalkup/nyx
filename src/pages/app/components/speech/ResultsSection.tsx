import { ChatConversation } from "@/types";
import { Markdown, Switch, CopyButton } from "@/components";
import { BotIcon, HeadphonesIcon, Loader2, SparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Gap (ms) between consecutive user messages that triggers a "new turn" separator. */
const TURN_GAP_MS = 2000;

type Props = {
  lastTranscription: string;
  lastAIResponse: string;
  isAIProcessing: boolean;
  conversation: ChatConversation;
  conversationMode: boolean;
  setConversationMode: (mode: boolean) => void;
};

export const ResultsSection = ({
  lastTranscription,
  lastAIResponse,
  isAIProcessing,
  conversation,
  conversationMode,
  setConversationMode,
}: Props) => {
  const hasResponse = lastAIResponse || isAIProcessing;
  const hasHistory = conversation.messages.length > 2;

  if (!hasResponse && !lastTranscription) {
    return null;
  }

  const isMac = navigator.platform.toLowerCase().includes("mac");
  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-3">
      {/* Header with toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <SparklesIcon className="w-3.5 h-3.5 text-primary" />
          <h4 className="text-xs font-medium">
            {conversationMode ? "Conversation" : "AI Response"}
          </h4>
        </div>
        <div className="flex items-center gap-2 select-none">
          <span className="text-[9px] text-muted-foreground/50 bg-muted/50 px-1 rounded">
            {modKey}+K
          </span>
          <Switch
            checked={conversationMode}
            onCheckedChange={setConversationMode}
            className="scale-75"
          />
          {lastAIResponse && <CopyButton content={lastAIResponse} />}
        </div>
      </div>

      {/* RESPONSE MODE: Rolling subtitle display */}
      {!conversationMode && (
        <div className="space-y-1.5">
          {/* Rolling history — older assistant responses, faded */}
          {conversation.messages.length > 2 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {conversation.messages
                .slice(2) // Skip the latest pair (shown below)
                .sort((a, b) => a.timestamp - b.timestamp) // Oldest first
                .slice(-6) // Show last 6 historical messages (3 pairs)
                .filter((message) => message.role === "assistant")
                .map((message, index) => (
                  <div
                    key={message.id || index}
                    className="text-[10px] text-muted-foreground/60 leading-relaxed prose prose-sm max-w-none dark:prose-invert"
                  >
                    <Markdown>{message.content}</Markdown>
                  </div>
                ))}
            </div>
          )}

          {/* Current segment — highlighted */}
          {lastTranscription && (
            <p className="text-[10px] text-muted-foreground/70 border-t border-border/30 pt-1">
              <span className="font-semibold">Heard:</span> {lastTranscription}
            </p>
          )}
          {hasResponse && (
            <div className="text-sm font-medium">
              {isAIProcessing && !lastAIResponse ? (
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <span className="text-xs text-muted-foreground">
                    Translating...
                  </span>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <Markdown>{lastAIResponse}</Markdown>
                  {isAIProcessing && (
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 align-middle" />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* CONVERSATION MODE: AI on top, then System, then history */}
      {conversationMode && (
        <div className="space-y-2">
          {/* AI Response - First (on top) */}
          {hasResponse && (
            <div className="rounded-md bg-background/50 p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <BotIcon className="h-3 w-3 text-muted-foreground" />
                <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                  AI
                </span>
              </div>
              {isAIProcessing && !lastAIResponse ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  <span className="text-[10px] text-muted-foreground">
                    Generating...
                  </span>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none dark:prose-invert text-sm">
                  <Markdown>{lastAIResponse}</Markdown>
                  {isAIProcessing && (
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 align-middle" />
                  )}
                </div>
              )}
            </div>
          )}

          {/* System Input - Second */}
          {lastTranscription && (
            <div className="rounded-md border-l-2 border-primary/50 bg-primary/5 p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <HeadphonesIcon className="h-3 w-3 text-primary" />
                <span className="text-[9px] font-medium text-primary uppercase tracking-wide">
                  System
                </span>
              </div>
              <p className="text-sm">{lastTranscription}</p>
            </div>
          )}

          {/* Previous Messages with Turn Separators */}
          {hasHistory && (
            <div className="space-y-2 pt-2 border-t border-border/50">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide">
                Previous
              </p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {conversation.messages
                  .slice(2)
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .map((message, index, sortedMessages) => {
                    // Detect turn gaps: when a user message follows an AI message
                    // and there's a >2s gap (comparing reverse-sorted timestamps)
                    const previousMessage = sortedMessages[index - 1];
                    const showTurnSeparator =
                      previousMessage &&
                      message.role === "user" &&
                      previousMessage.role !== "user" &&
                      previousMessage.timestamp - message.timestamp > TURN_GAP_MS;

                    return (
                      <div key={message.id || index}>
                        {showTurnSeparator && (
                          <div className="flex items-center gap-2 py-1">
                            <div className="flex-1 border-t border-border/30" />
                            <span className="text-[8px] text-muted-foreground/50 uppercase tracking-wider">
                              new turn
                            </span>
                            <div className="flex-1 border-t border-border/30" />
                          </div>
                        )}
                        <div
                          className={cn(
                            "p-2 rounded-md text-[11px]",
                            message.role === "user"
                              ? "bg-primary/5 border-l-2 border-primary/30"
                              : "bg-background/50"
                          )}
                        >
                          <span className="text-[8px] font-medium text-muted-foreground uppercase">
                            {message.role === "user" ? "System" : "AI"}
                          </span>
                          <div className="text-muted-foreground leading-relaxed mt-0.5">
                            <Markdown>{message.content}</Markdown>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
