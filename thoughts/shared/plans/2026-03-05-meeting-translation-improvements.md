# Meeting Translation Improvements - Implementation Plan

## Overview

Improve Nyx's live meeting translation experience for the core use-case: a non-native speaker following a foreign-language board meeting in real-time. This plan covers 8 improvements across system prompts, transcription filtering, utterance queuing, speaker turn separation, STT/LLM concurrency, rolling subtitle display, meeting language picker, and advanced VAD settings.

## Current State Analysis

- **System audio capture**: macOS CoreAudio tap → Rust VAD → `speech-detected` event → STT → LLM
- **Empty transcription guard**: Working correctly. `fetchSTT` returns `null` for empty results, `useSystemAudio.ts:346` skips AI calls for falsy transcriptions, dedup guard prevents double-fires within 3s
- **System prompts**: Stored in SQLite via `system-prompt.action.ts`, selected via `useSystemPrompts` hook. `DEFAULT_SYSTEM_PROMPT` is a generic assistant prompt hardcoded in `constants.ts` but never inserted into the DB — users start with zero prompts and must create their own
- **Overlay display**: `ResultsSection` shows `lastTranscription` + `lastAIResponse` — replaces on each new segment, with `conversation.messages` history in a small scrollable area
- **Utterance handling**: `processWithAI` aborts any in-flight request before starting a new one — fast speakers lose translations
- **VAD settings**: Sensitivity presets (Low/Normal/High) + advanced sliders in the overlay `SettingsPanel`; `min_speech_chunks` and `peak_threshold` are not exposed to the user
- **STT language**: Defaults to `"auto"`, configurable in app context but not prominently surfaced during meeting start

### Key Discoveries:
- `PROMPT_TEMPLATES` in `src/lib/platform-instructions.ts:7-126` already has a "Real-time Translator" template, but it's only available as a context template in the SettingsPanel — not as a first-class system prompt
- `processWithAI` at `useSystemAudio.ts:564-649` creates a new `AbortController` and aborts the previous one each time — this is the core issue for fast-speaking meetings
- `ResultsSection` at `src/pages/app/components/speech/ResultsSection.tsx:1-167` has two modes but both show only the latest transcription/response pair
- The Rust VAD (`commands.rs:135-257`) uses RMS + peak detection but no frequency filtering
- Dev Space page (`src/pages/dev/index.tsx`) is a simple layout with AI + STT provider sections — easy to extend
- The `VadConfig` struct in Rust (`commands.rs:18-29`) and TypeScript (`useSystemAudio.ts:32-42`) must stay in sync

## Desired End State

After implementation:
1. Users see two built-in system prompts on first launch: "General Assistant" and "Meeting Translator"
2. Short/filler transcriptions (<5 words after light cleanup) are discarded before hitting the LLM
3. Consecutive utterances queue instead of aborting — every translation completes
4. Visual turn separators appear between utterance groups (>2s gap)
5. STT and LLM run concurrently when pipeline allows it
6. The overlay shows a rolling subtitle-style log of the last N translated segments
7. A meeting language picker appears when starting a new capture session
8. Advanced VAD settings (min speech duration, peak threshold) are exposed in Dev Space dashboard

### Verification:
- Start a capture session, speak short filler words → they should be discarded (console log confirms)
- Speak two sentences rapidly → both should be translated (neither aborted)
- Pause >2s between utterance groups → visual separator appears in overlay
- Overlay shows a scrolling list of recent translations, not just the latest one
- Meeting language picker allows setting source language before capture begins
- Dev Space shows new VAD advanced settings section

## What We're NOT Doing

- Speaker diarization (identifying *who* is speaking) — too complex for this iteration
- Partial/streaming STT results — depends on provider support
- Frequency-based bandpass filter in Rust VAD — internal optimization, not user-exposed (implemented but not exposed)
- Cross-utterance context accumulation (sending buffered transcriptions as combined blocks) — deferred to a follow-up
- Dual-language display (original + translation side-by-side) — deferred

## Implementation Approach

Eight phases, each independently testable. Phases are ordered to minimize cross-dependencies: data/config changes first, then pipeline logic, then UI.

---

## Phase 1: Built-in System Prompts (Seeding)

### Overview
Add two built-in system prompts that are automatically inserted into the database on first launch: "General Assistant" (the existing default) and "Meeting Translator" (translation-optimized). This ensures day-0 users have useful prompts without manual setup.

### Changes Required:

#### 1. Add default prompts constant
**File**: `src/config/constants.ts`
**Changes**: Add a `DEFAULT_SYSTEM_PROMPTS` array with two entries

```typescript
export const DEFAULT_SYSTEM_PROMPTS = [
  {
    name: "General Assistant",
    prompt: DEFAULT_SYSTEM_PROMPT,
  },
  {
    name: "Meeting Translator",
    prompt: `You are a real-time meeting interpreter. Your sole job is to translate speech into the user's language accurately and immediately.

Rules:
- Translate what was said. Do not summarize, comment, or add your own thoughts.
- Preserve the speaker's tone and intent (formal, casual, urgent, etc.).
- If a phrase is ambiguous, translate the most likely meaning in context.
- For proper nouns, company names, and technical terms, keep the original alongside a translation if helpful.
- Keep translations concise — the user is reading in real-time during a live meeting.
- If the input is already in the user's language, pass it through unchanged.
- Never say "I don't understand" or ask clarifying questions — just translate what you received.`,
  },
];
```

#### 2. Seed prompts on first launch
**File**: `src/hooks/useSystemPrompts.ts`
**Changes**: In the `fetchPrompts` callback, after fetching, check if the DB is empty. If so, insert the two default prompts and auto-select "General Assistant".

```typescript
// After line 39 (const result = await getAllSystemPrompts();)
if (result.length === 0) {
  // First launch — seed default prompts
  for (const defaultPrompt of DEFAULT_SYSTEM_PROMPTS) {
    await createSystemPrompt(defaultPrompt);
  }
  const seededPrompts = await getAllSystemPrompts();
  setPrompts(seededPrompts);
  // Auto-select the first prompt (General Assistant)
  if (seededPrompts.length > 0) {
    const generalAssistant = seededPrompts.find(p => p.name === "General Assistant");
    if (generalAssistant) {
      // Set as active
      setSystemPrompt(generalAssistant.prompt);
      setSelectedPromptId(generalAssistant.id);
      safeLocalStorage.setItem(STORAGE_KEYS.SYSTEM_PROMPT, generalAssistant.prompt);
      safeLocalStorage.setItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID, generalAssistant.id.toString());
    }
  }
  return; // Already set prompts above
}
```

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors: `npm run build` (or equivalent)
- [x] TypeScript compiles: `npx tsc --noEmit`

#### Manual Verification:
- [ ] Fresh install (clear DB) shows two prompts in System Prompts page
- [ ] "General Assistant" is auto-selected on first launch
- [ ] "Meeting Translator" is available and selectable
- [ ] Selecting "Meeting Translator" changes the system prompt used for system audio AI calls
- [ ] Existing users with prompts already in DB are not affected (no duplicate seeding)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 2: Short/Filler Transcription Filtering

### Overview
Discard transcriptions that are too short to be meaningful (< 5 words after trimming punctuation and whitespace). This prevents filler sounds, mic bumps that produce a word or two, and other noise from reaching the LLM.

### Changes Required:

#### 1. Add minimum word count filter
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: Add a filtering function and use it in the `speech-detected` handler after the truthy check at line 346

```typescript
// New constant near the top (after TRANSCRIPTION_DEDUP_WINDOW_MS)
const MIN_TRANSCRIPTION_WORDS = 5;

/**
 * Returns true if the transcription is too short to be meaningful.
 * Strips punctuation and extra whitespace, then checks word count.
 */
function isTranscriptionTooShort(text: string): boolean {
  const cleaned = text
    .replace(/[^\p{L}\p{N}\s]/gu, "") // Remove punctuation, keep letters/numbers/spaces
    .replace(/\s+/g, " ")              // Collapse whitespace
    .trim();
  const wordCount = cleaned.split(" ").filter(Boolean).length;
  return wordCount < MIN_TRANSCRIPTION_WORDS;
}
```

Then, inside the `if (sttResult.transcription)` block (after the duplicate check at line 348), add:

```typescript
if (isTranscriptionTooShort(sttResult.transcription)) {
  console.debug(
    "Transcription too short, discarding:",
    sttResult.transcription,
  );
  return;
}
```

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors
- [x] TypeScript compiles

#### Manual Verification:
- [ ] Short utterances like "um" or "okay" are discarded (check console for debug log)
- [ ] Normal sentences (5+ words) are processed normally
- [ ] Punctuation-heavy short strings like "..." or "??" are discarded
- [ ] Multi-word meaningful short phrases in other languages still pass if they have 5+ words

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Phase 3: Utterance Queue (No More Aborting In-Flight Translations)

### Overview
Replace the abort-and-restart pattern in `processWithAI` with a queue. When a new transcription arrives while the LLM is still processing, it queues instead of aborting. Each translation completes before the next starts.

### Changes Required:

#### 1. Add queue mechanism to useSystemAudio
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: Add a queue ref and a processing flag, modify the speech-detected handler to enqueue, and modify `processWithAI` to dequeue.

Add refs near the other refs (around line 121):
```typescript
const processingQueueRef = useRef<Array<{
  transcription: string;
  systemPrompt: string;
  previousMessages: Message[];
}>>([]);
const isQueueProcessingRef = useRef<boolean>(false);
```

Add a `processQueue` function that drains the queue:
```typescript
const processQueue = useCallback(async () => {
  if (isQueueProcessingRef.current) return;
  isQueueProcessingRef.current = true;

  while (processingQueueRef.current.length > 0) {
    const nextItem = processingQueueRef.current.shift();
    if (!nextItem) break;

    await processWithAI(
      nextItem.transcription,
      nextItem.systemPrompt,
      nextItem.previousMessages,
    );
  }

  isQueueProcessingRef.current = false;
}, [processWithAI]);
```

Modify the speech-detected handler (replacing the direct `processWithAI` call at line 374):
```typescript
// Instead of: await processWithAI(...)
processingQueueRef.current.push({
  transcription: sttResult.transcription,
  systemPrompt: effectiveSystemPrompt,
  previousMessages,
});
processQueue();
```

Remove the `abortControllerRef.current.abort()` call at the top of `processWithAI` (line 570-572). Keep the abort controller for the stopCapture cleanup.

#### 2. Keep abort for stop/cleanup only
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: In `stopCapture` (line 709), also clear the queue:

```typescript
processingQueueRef.current = [];
```

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors
- [x] TypeScript compiles

#### Manual Verification:
- [ ] Speak two sentences rapidly with short pause between — both should be translated
- [ ] The overlay shows both translations sequentially (second appears after first completes)
- [ ] Stopping capture clears the queue and aborts any in-flight request
- [ ] Quick actions still work correctly (they call processWithAI directly)

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Phase 4: Speaker Turn Separation

### Overview
When there's a significant gap (>2s) between consecutive transcriptions, insert a visual separator in the conversation log to indicate a new "turn" in the meeting. This helps the user see the structure of the discussion.

### Changes Required:

#### 1. Track timestamps on conversation messages
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: The timestamps are already tracked on each message. No hook changes needed.

#### 2. Add visual separator in ResultsSection
**File**: `src/pages/app/components/speech/ResultsSection.tsx`
**Changes**: In the conversation mode history section, detect when consecutive user messages have timestamps >2s apart and render a divider.

```typescript
// Add constant at top of file
const TURN_GAP_MS = 2000;
```

In the conversation mode's "Previous Messages" section (around line 139), when mapping messages, check the time gap between consecutive `user` role messages:

```typescript
{conversation.messages
  .slice(2)
  .sort((a, b) => b.timestamp - a.timestamp)
  .map((message, index, sortedMessages) => {
    // Check if there's a turn gap before this message
    const previousMessage = sortedMessages[index - 1];
    const showTurnSeparator = previousMessage
      && message.role === "user"
      && previousMessage.role !== "user"
      && previousMessage.timestamp - message.timestamp > TURN_GAP_MS;

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
          {/* ... existing message content ... */}
        </div>
      </div>
    );
  })}
```

Also add the same separator logic in the non-conversation mode (response mode), so the last transcription label shows the turn indicator when there's been a gap. This is a lighter touch — just add a small timestamp or "---" divider above the `System:` label when the current transcription is >2s after the previous user message in the conversation.

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors
- [x] TypeScript compiles

#### Manual Verification:
- [ ] Speak, pause 3+ seconds, speak again — "new turn" separator appears between the groups
- [ ] Rapid back-to-back speech does NOT show separators
- [ ] Separators render correctly in both conversation mode and response mode

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Phase 5: STT/LLM Concurrency

### Overview
When using separate STT and LLM providers (not a single multimodal endpoint), allow the next audio segment's STT to run concurrently while the previous segment's LLM call is still in progress. This reduces perceived latency.

### Changes Required:

#### 1. Decouple STT from LLM processing
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: The speech-detected handler currently runs STT, then calls processWithAI (or enqueues) synchronously. The change: let STT run freely without waiting for the queue to drain. The queue handles LLM ordering; STT should fire immediately for every speech-detected event.

The current structure is already close to this after Phase 3's queue changes. The key insight: `fetchSTT` already runs independently — it's the `await processWithAI(...)` that was blocking. With the queue from Phase 3, `processQueue()` returns immediately if already processing, so STT calls for subsequent segments can fire while LLM is processing.

**Verify**: After Phase 3, the speech-detected handler calls `processQueue()` which returns immediately if already draining. So STT for segment N+1 starts as soon as its audio arrives, regardless of whether segment N's LLM call is done. The queue ensures LLM calls happen in order.

The only remaining issue: `setIsProcessing(true)` at line 316 stays true while STT is running, and `setIsProcessing(false)` in the `finally` block at line 392. If a second speech event fires while the first is still in STT, the `isProcessing` flag may flicker. Fix: track per-segment processing state separately, or simply let multiple STT calls overlap and only use `isAIProcessing` for UI feedback.

**Change**: Replace the `isProcessing` flag usage so multiple STT calls can overlap:
```typescript
// Instead of setIsProcessing(true) at the start of the handler,
// use a counter ref:
const activeSTTCountRef = useRef<number>(0);

// At start of speech-detected handler:
activeSTTCountRef.current += 1;
setIsProcessing(true);

// In finally block:
activeSTTCountRef.current -= 1;
if (activeSTTCountRef.current === 0) {
  setIsProcessing(false);
}
```

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors
- [x] TypeScript compiles

#### Manual Verification:
- [ ] Speak two sentences with 1s gap — STT for the second starts while LLM processes the first
- [ ] Processing indicator stays active until all STT calls complete
- [ ] No race conditions in state updates (no flickering UI)

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Phase 6: Rolling Subtitle Display

### Overview
Transform the overlay from showing only the latest transcription/response to a rolling log of the last N translated segments, similar to live subtitles. The most recent segment is at the bottom and highlighted, older segments fade.

### Changes Required:

#### 1. Redesign ResultsSection for subtitle mode
**File**: `src/pages/app/components/speech/ResultsSection.tsx`
**Changes**: In response mode (non-conversation mode), instead of showing only `lastTranscription` + `lastAIResponse`, show a rolling list from `conversation.messages` with the latest pair at the bottom.

Replace the response mode section with:
```tsx
{!conversationMode && (
  <div className="space-y-1.5">
    {/* Rolling history - show last N message pairs */}
    {conversation.messages.length > 2 && (
      <div className="space-y-1 max-h-32 overflow-y-auto">
        {conversation.messages
          .slice(2) // Skip the latest pair (shown below)
          .sort((a, b) => a.timestamp - b.timestamp) // Oldest first
          .slice(-6) // Show last 6 historical messages (3 pairs)
          .map((message, index) => (
            <div
              key={message.id || index}
              className="text-[10px] text-muted-foreground/60 leading-relaxed"
            >
              {message.role === "assistant" && (
                <Markdown>{message.content}</Markdown>
              )}
            </div>
          ))
        }
      </div>
    )}

    {/* Current segment - highlighted */}
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
            <span className="text-xs text-muted-foreground">Translating...</span>
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
```

#### 2. Auto-scroll to bottom
The `scrollAreaRef` is already on the `ScrollArea` in the parent component. Add an auto-scroll effect in the parent (`speech/index.tsx`) that scrolls to bottom when `lastAIResponse` changes:

```typescript
// In SystemAudio component, add effect:
useEffect(() => {
  if (!lastAIResponse) return;
  const scrollElement = scrollAreaRef.current?.querySelector(
    "[data-radix-scroll-area-viewport]",
  ) as HTMLElement;
  if (scrollElement) {
    scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: "smooth" });
  }
}, [lastAIResponse, scrollAreaRef]);
```

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors
- [x] TypeScript compiles

#### Manual Verification:
- [ ] After 3+ translations, the overlay shows a rolling log with older translations faded
- [ ] The latest translation is prominent at the bottom
- [ ] Auto-scrolls to the latest translation
- [ ] Conversation mode still works as before (unaffected)
- [ ] The overlay doesn't grow unboundedly — only last few pairs shown in response mode

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Phase 7: Meeting Language Picker

### Overview
Add a meeting language selector that appears when starting a new capture session. This sets the STT source language (telling Whisper what language to expect). Defaults to "auto" but allows the user to select a specific language. Since speakers may drift between languages, "auto" remains the default and the picker is optional.

### Changes Required:

#### 1. Add a language picker to the overlay header area
**File**: `src/pages/app/components/speech/index.tsx`
**Changes**: When capturing is active and the popover is open, show a small language select in the header bar (next to the Mode Switcher). This uses the existing `sttLanguage` state from `useApp()`.

Add to the component:
```typescript
const { sttLanguage, setSttLanguage } = useApp();
```

Add a compact language selector in the header (inside the action buttons area, line ~233):
```tsx
{/* Meeting Language Selector */}
{!setupRequired && (
  <Select value={sttLanguage} onValueChange={setSttLanguage}>
    <SelectTrigger className="h-6 w-auto text-[10px] gap-1 px-2 min-w-0">
      <GlobeIcon className="w-3 h-3 flex-shrink-0" />
      <SelectValue placeholder="Auto" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="auto" className="text-xs">Auto-detect</SelectItem>
      <SelectItem value="it" className="text-xs">Italian</SelectItem>
      <SelectItem value="en" className="text-xs">English</SelectItem>
      <SelectItem value="es" className="text-xs">Spanish</SelectItem>
      <SelectItem value="fr" className="text-xs">French</SelectItem>
      <SelectItem value="de" className="text-xs">German</SelectItem>
      <SelectItem value="pt" className="text-xs">Portuguese</SelectItem>
      <SelectItem value="zh" className="text-xs">Chinese</SelectItem>
      <SelectItem value="ja" className="text-xs">Japanese</SelectItem>
      <SelectItem value="ko" className="text-xs">Korean</SelectItem>
      <SelectItem value="ar" className="text-xs">Arabic</SelectItem>
      <SelectItem value="ru" className="text-xs">Russian</SelectItem>
      <SelectItem value="nl" className="text-xs">Dutch</SelectItem>
      <SelectItem value="pl" className="text-xs">Polish</SelectItem>
      <SelectItem value="tr" className="text-xs">Turkish</SelectItem>
    </SelectContent>
  </Select>
)}
```

#### 2. Verify `setSttLanguage` is available in context
**File**: `src/contexts/app.context.tsx`
**Changes**: Verify `setSttLanguage` is exposed. It likely already is since `sttLanguage` is a state variable there. If not, expose the setter.

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors
- [x] TypeScript compiles

#### Manual Verification:
- [ ] Language picker appears in the overlay header when capturing
- [ ] Selecting "Italian" sets STT language to "it"
- [ ] Italian speech is transcribed more accurately with "it" selected vs "auto"
- [ ] Switching back to "auto" works mid-session
- [ ] Language selection persists across sessions (already handled by existing localStorage logic)

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Phase 8: Advanced VAD Settings in Dev Space

### Overview
Expose `min_speech_chunks` (minimum speech duration) and `peak_threshold` in the Dev Space dashboard as advanced settings. These help tune the VAD for meeting room environments where coughs, keyboard sounds, and HVAC trigger false positives. The frequency-based bandpass filter is implemented internally in Rust but not exposed to the UI.

### Changes Required:

#### 1. Add VAD settings component to Dev Space
**File**: `src/pages/dev/components/VadAdvancedSettings.tsx` (new file)
**Changes**: Create a component with sliders for `min_speech_chunks` and `peak_threshold`, following the same pattern as `SettingsPanel`.

```tsx
import { Label, Slider } from "@/components";
import { Header } from "@/components";
import { VadConfig } from "@/hooks/useSystemAudio";

interface VadAdvancedSettingsProps {
  vadConfig: VadConfig;
  onUpdateVadConfig: (config: VadConfig) => void;
}

export const VadAdvancedSettings = ({
  vadConfig,
  onUpdateVadConfig,
}: VadAdvancedSettingsProps) => {
  return (
    <div className="space-y-2">
      <Header
        title="VAD Advanced Settings"
        description="Fine-tune voice activity detection for your environment"
        isMainTitle
      />

      {/* Min Speech Duration */}
      <div className="space-y-2 rounded-xl border p-4">
        <Label className="text-xs font-medium flex items-center justify-between">
          <span>Minimum Speech Duration</span>
          <span className="text-muted-foreground font-normal">
            {((vadConfig.min_speech_chunks * vadConfig.hop_size) / 44100 * 1000).toFixed(0)}ms
          </span>
        </Label>
        <Slider
          value={[vadConfig.min_speech_chunks]}
          onValueChange={([value]) =>
            onUpdateVadConfig({
              ...vadConfig,
              min_speech_chunks: Math.round(value),
            })
          }
          min={3}
          max={30}
          step={1}
        />
        <p className="text-[10px] text-muted-foreground">
          Audio shorter than this is discarded. Increase to filter coughs and clicks.
        </p>
      </div>

      {/* Peak Threshold */}
      <div className="space-y-2 rounded-xl border p-4">
        <Label className="text-xs font-medium flex items-center justify-between">
          <span>Peak Threshold</span>
          <span className="text-muted-foreground font-normal">
            {(vadConfig.peak_threshold * 1000).toFixed(1)}
          </span>
        </Label>
        <Slider
          value={[vadConfig.peak_threshold * 1000]}
          onValueChange={([value]) =>
            onUpdateVadConfig({
              ...vadConfig,
              peak_threshold: value / 1000,
            })
          }
          min={10}
          max={100}
          step={1}
        />
        <p className="text-[10px] text-muted-foreground">
          Higher values require louder peaks to trigger speech detection. Helps in noisy rooms.
        </p>
      </div>
    </div>
  );
};
```

#### 2. Wire into Dev Space page
**File**: `src/pages/dev/index.tsx`
**Changes**: Import the new component and pass VAD config from a hook. We need to access the VAD config — which currently lives in `useSystemAudio`. Since Dev Space doesn't use `useSystemAudio`, we need to read/write VAD config from localStorage directly (same pattern as the SettingsPanel).

```typescript
import { VadAdvancedSettings } from "./components";
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VadConfig } from "@/hooks/useSystemAudio";
import { safeLocalStorage } from "@/lib";

// Inside DevSpace component:
const [vadConfig, setVadConfig] = useState<VadConfig>(() => {
  const saved = safeLocalStorage.getItem("vad_config");
  if (saved) {
    try { return JSON.parse(saved); } catch { /* fall through */ }
  }
  return DEFAULT_VAD_CONFIG; // import from useSystemAudio
});

const updateVadConfig = useCallback(async (config: VadConfig) => {
  setVadConfig(config);
  safeLocalStorage.setItem("vad_config", JSON.stringify(config));
  try {
    await invoke("update_vad_config", { config });
  } catch (error) {
    console.error("Failed to update VAD config:", error);
  }
}, []);
```

Then render below ShowThinkingToggle:
```tsx
<VadAdvancedSettings
  vadConfig={vadConfig}
  onUpdateVadConfig={updateVadConfig}
/>
```

#### 3. Export DEFAULT_VAD_CONFIG from useSystemAudio
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: Export `DEFAULT_VAD_CONFIG` so it can be imported by DevSpace.

```typescript
// Change from:
const DEFAULT_VAD_CONFIG: VadConfig = { ... };
// To:
export const DEFAULT_VAD_CONFIG: VadConfig = { ... };
```

#### 4. Add bandpass filter in Rust (internal, not exposed)
**File**: `src-tauri/src/speaker/commands.rs`
**Changes**: Add a simple single-pole bandpass filter (300-3000 Hz) applied before RMS/peak calculation in `run_vad_capture`. This is purely internal — no UI exposure.

Add a helper function:
```rust
/// Simple bandpass filter for human speech frequencies (300-3000 Hz).
/// Uses first-order high-pass + low-pass cascaded filters.
fn bandpass_filter_speech(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    let high_cutoff = 300.0;
    let low_cutoff = 3000.0;

    // High-pass RC filter coefficient
    let rc_high = 1.0 / (2.0 * std::f32::consts::PI * high_cutoff);
    let dt = 1.0 / sample_rate as f32;
    let alpha_high = rc_high / (rc_high + dt);

    // Low-pass RC filter coefficient
    let rc_low = 1.0 / (2.0 * std::f32::consts::PI * low_cutoff);
    let alpha_low = dt / (rc_low + dt);

    let mut filtered = vec![0.0f32; samples.len()];

    // High-pass pass
    filtered[0] = samples[0];
    for i in 1..samples.len() {
        filtered[i] = alpha_high * (filtered[i - 1] + samples[i] - samples[i - 1]);
    }

    // Low-pass pass (in-place)
    let mut prev = filtered[0];
    for i in 1..filtered.len() {
        filtered[i] = prev + alpha_low * (filtered[i] - prev);
        prev = filtered[i];
    }

    filtered
}
```

Then in `run_vad_capture`, after noise gate and before `calculate_audio_metrics`:
```rust
let mono = apply_noise_gate(&mono, config.noise_gate_threshold);
let mono_for_vad = bandpass_filter_speech(&mono, sr);
let (rms, peak) = calculate_audio_metrics(&mono_for_vad);
// Note: still use `mono` (not filtered) for the speech buffer,
// only use filtered version for VAD decision-making
```

### Success Criteria:

#### Automated Verification:
- [x] App builds without errors (both Rust and TypeScript)
- [x] TypeScript compiles
- [x] `cargo check` passes

#### Manual Verification:
- [ ] Dev Space shows "VAD Advanced Settings" section with two sliders
- [ ] Adjusting Min Speech Duration changes the threshold for what gets discarded
- [ ] Adjusting Peak Threshold changes sensitivity to loud transient sounds
- [ ] Settings persist across app restarts
- [ ] The bandpass filter reduces false VAD triggers from HVAC/typing noise (test by tapping desk near mic)

**Implementation Note**: Pause for manual confirmation after this phase.

---

## Testing Strategy

### Unit Tests:
- `isTranscriptionTooShort` — test with various inputs: empty, punctuation-only, 4 words, 5 words, unicode
- `bandpass_filter_speech` — verify output is non-empty and within expected range for a simple sine wave input

### Integration Tests:
- Full pipeline: audio → VAD → STT → filter → queue → LLM → display
- Queue ordering: verify translations appear in order when multiple segments arrive rapidly

### Manual Testing Steps:
1. Fresh install: verify two system prompts appear, General Assistant is selected
2. Select Meeting Translator, start capture with Italian audio, verify translation output
3. Speak short filler words — verify they're discarded (check console)
4. Speak two sentences rapidly — verify both are translated (queue, not abort)
5. Pause >2s between groups — verify turn separator appears
6. Check overlay shows rolling subtitle log, not just latest
7. Change meeting language to "it" — verify improved Italian transcription accuracy
8. In Dev Space, adjust Min Speech Duration up — verify short sounds are filtered more aggressively
9. Tap desk near mic — verify bandpass filter reduces false triggers

## Performance Considerations

- **Queue memory**: The queue is in-memory and unbounded. In practice, segments arrive every 1-3s and LLM calls take 1-5s, so the queue rarely exceeds 2-3 items. Add a safety cap of 10 items — drop oldest if exceeded.
- **STT concurrency**: Multiple concurrent STT calls will increase network usage. Cap at 3 concurrent STT calls.
- **Rolling display**: Only rendering last 6 historical messages (3 pairs) keeps DOM size constant.
- **Bandpass filter**: O(n) single-pass filter on ~1024 samples per hop — negligible CPU overhead.

## References

- System audio pipeline: `src/hooks/useSystemAudio.ts`
- STT function: `src/lib/functions/stt.function.ts`
- AI response function: `src/lib/functions/ai-response.function.ts`
- Overlay components: `src/pages/app/components/speech/`
- Rust VAD: `src-tauri/src/speaker/commands.rs`
- System prompts: `src/hooks/useSystemPrompts.ts`, `src/lib/database/system-prompt.action.ts`
- Dev Space: `src/pages/dev/index.tsx`
- Platform instructions (templates): `src/lib/platform-instructions.ts`
