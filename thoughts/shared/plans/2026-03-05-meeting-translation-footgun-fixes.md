# Meeting Translation Footgun Fixes — Implementation Plan

## Overview

Fix 10 concurrency, ordering, and correctness bugs identified during review of the meeting translation improvements. These are all real footguns — not refactors or nice-to-haves.

## Current State Analysis

The meeting translation implementation (Phase 1–8) is functionally complete but has several correctness issues:

1. **STT calls run concurrently but nothing preserves utterance order** — segment N+1 can finish STT before segment N, get enqueued first, and appear out of order in the translation queue
2. **Queue captures `previousMessages` at enqueue time** — by the time the LLM processes a queued item, earlier items have already added new messages to the conversation, making the captured context stale
3. **No session invalidation** — stopping and restarting capture can leak stale in-flight STT/LLM results into the new session
4. **Meeting Translator prompt says "translate into the user's language"** but nothing tells the model what that language is
5. **Queue has a safety cap of 10 but no explicit backpressure strategy** — for live translation, stale translations are useless
6. **Single shared `abortControllerRef`** — with concurrent STT + queued LLM, abort ownership is unclear
7. **`bandpass_filter_speech()` panics on empty input** at `filtered[0] = samples[0]` — already fixed with the `is_empty()` guard but filter state resets every chunk
8. **Filter reinitializes every chunk** — edge artifacts from resetting RC filter coefficients
9. **Hardcoded `44100` in `VadAdvancedSettings.tsx`** — displayed ms is wrong if actual sample rate differs
10. **No target language UX** — source language picker exists, but the more important question for a translator ("what language should I translate INTO?") is unanswered

### Key Discoveries:
- `sttLanguage` state lives in `AppContext` (`app.context.tsx:320-327`), persisted to localStorage under `STORAGE_KEYS.STT_LANGUAGE`
- No `targetLanguage` concept exists anywhere in the codebase
- `bandpass_filter_speech` at `commands.rs:367-400` already has the empty guard, but creates a fresh `Vec` and reinitializes filter state every call
- The queue at `useSystemAudio.ts:145-152` stores `{ transcription, systemPrompt, previousMessages }` — previousMessages is a snapshot
- `processWithAI` at `useSystemAudio.ts:614-695` creates a new AbortController on every call, replacing the previous one
- The `VadAdvancedSettings.tsx:14-16` computation uses literal `44100`
- `start_system_audio_capture` at `commands.rs:48` already reads `sr` from the stream — it's available but not exposed to the frontend

## Desired End State

After these fixes:
1. Translations appear in the order the audio was spoken, regardless of STT completion order
2. Each queued LLM call uses fresh conversation context at dequeue time
3. Stopping capture invalidates all in-flight requests — nothing leaks into the next session
4. The Meeting Translator prompt includes the explicit target language
5. Queue drops oldest items when backlogged, keeping translations timely
6. Each LLM call owns its own AbortController
7. Bandpass filter handles all edge cases safely
8. Filter state persists across audio chunks for correct frequency response
9. VadAdvancedSettings displays correct ms for any sample rate
10. Users can set their target language for translation

### Verification:
- Speak 3 sentences rapidly in sequence → translations appear in spoken order
- Stop and restart capture mid-translation → no stale results appear
- Set target language to English, speak Italian → translations explicitly come back in English
- Queue 5+ items, check that oldest are dropped when speaker outpaces LLM
- Dev Space VAD settings show correct ms values

## What We're NOT Doing

- `TranslatedSegment` data model refactor — correct fix but too large for this pass
- Audio-timestamp-based turn separators — requires plumbing timestamps from Rust VAD
- Making translation a first-class mode separate from system prompts
- STT concurrency semaphore/cap — human speech pace makes this unnecessary

## Implementation Approach

Group fixes by file to minimize churn. Three main areas:
1. **Frontend pipeline** (`useSystemAudio.ts`) — fixes #1, #2, #3, #5, #6
2. **UX + config** (`constants.ts`, `speech/index.tsx`, `VadAdvancedSettings.tsx`, `AppContext`) — fixes #4, #9, #10
3. **Rust audio** (`commands.rs`) — fixes #7, #8

---

## Phase 1: Sequencing, Session Tokens, and Queue Fixes

### Overview
Fix the core pipeline correctness issues: utterance ordering, stale context, session invalidation, backpressure, and AbortController ownership.

### Changes Required:

#### 1. Add sequence counter and session token refs
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: Add `sequenceRef` and `sessionIdRef` refs alongside existing refs.

```typescript
/** Monotonic sequence number stamped on each speech-detected event. */
const sequenceRef = useRef<number>(0);

/** Session ID incremented on stop — in-flight requests check this to avoid leaking into next session. */
const sessionIdRef = useRef<number>(0);
```

#### 2. Restructure queue item type to include sequence number
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: Update the queue item type. Remove `previousMessages` from the queue item (will be computed at dequeue time). Add `seq` and `sessionId`.

Replace the existing queue ref type:
```typescript
/** Queue of transcriptions waiting for LLM processing. */
const processingQueueRef = useRef<
	Array<{
		transcription: string;
		systemPrompt: string;
		previousMessages: Message[];
	}>
>([]);
```

With:
```typescript
/** Queue of transcriptions waiting for LLM processing. */
const processingQueueRef = useRef<
	Array<{
		seq: number;
		sessionId: number;
		transcription: string;
		systemPrompt: string;
	}>
>([]);
```

#### 3. Stamp sequence and session at speech-detected time, sort before enqueue
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: In the `speech-detected` handler, after the short-text filter passes:

Replace the existing enqueue block (lines ~413-425):
```typescript
// Enqueue for sequential LLM processing (no abort)
processingQueueRef.current.push({
	transcription: sttResult.transcription,
	systemPrompt: effectiveSystemPrompt,
	previousMessages,
});

// Safety cap: drop oldest if queue grows too large
if (processingQueueRef.current.length > 10) {
	processingQueueRef.current.shift();
}
```

With:
```typescript
const seq = sequenceRef.current++;
const currentSessionId = sessionIdRef.current;

// Enqueue for sequential LLM processing
processingQueueRef.current.push({
	seq,
	sessionId: currentSessionId,
	transcription: sttResult.transcription,
	systemPrompt: effectiveSystemPrompt,
});

// Sort by sequence to correct STT completion order
processingQueueRef.current.sort((a, b) => a.seq - b.seq);

// Backpressure: drop oldest when queue exceeds cap
const MAX_QUEUE_SIZE = 5;
while (processingQueueRef.current.length > MAX_QUEUE_SIZE) {
	processingQueueRef.current.shift();
}
```

Also remove the `previousMessages` computation that currently happens before enqueue (lines ~405-411), since context will be computed at dequeue time.

#### 4. Update `processQueue` to compute context at dequeue time and check session
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: Replace the existing `processQueue` function:

```typescript
/** Drains the processing queue, running LLM calls sequentially in order. */
const processQueue = useCallback(async () => {
	if (isQueueProcessingRef.current) return;
	isQueueProcessingRef.current = true;

	while (processingQueueRef.current.length > 0) {
		const nextItem = processingQueueRef.current.shift();
		if (!nextItem) break;

		// Skip items from a previous session
		if (nextItem.sessionId !== sessionIdRef.current) continue;

		// Compute fresh context at dequeue time
		const freshPreviousMessages = conversation.messages.map((msg) => ({
			role: msg.role,
			content: msg.content,
		}));

		await processWithAI(
			nextItem.transcription,
			nextItem.systemPrompt,
			freshPreviousMessages,
		);
	}

	isQueueProcessingRef.current = false;
}, [processWithAI, conversation.messages]);
```

#### 5. Give each LLM call its own AbortController
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: In `processWithAI`, replace the shared ref pattern with a local controller, and track active controllers in a Set for cleanup.

Add a new ref:
```typescript
/** Set of active AbortControllers for in-flight LLM requests. */
const activeControllersRef = useRef<Set<AbortController>>(new Set());
```

Update `processWithAI` (line ~620):
```typescript
const processWithAI = useCallback(
	async (
		transcription: string,
		prompt: string,
		previousMessages: Message[],
	) => {
		const controller = new AbortController();
		activeControllersRef.current.add(controller);
```

And in the finally block:
```typescript
	} finally {
		activeControllersRef.current.delete(controller);
		setIsAIProcessing(false);
	}
```

Remove the old `abortControllerRef` entirely.

#### 6. Increment session ID and abort all controllers on stop
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: In `stopCapture`, replace the single abort with session invalidation + abort-all:

```typescript
const stopCapture = useCallback(async () => {
	try {
		// Invalidate current session so in-flight results are ignored
		sessionIdRef.current += 1;

		// Clear the processing queue
		processingQueueRef.current = [];
		isQueueProcessingRef.current = false;

		// Abort all in-flight LLM requests
		for (const controller of activeControllersRef.current) {
			controller.abort();
		}
		activeControllersRef.current.clear();

		// ... rest unchanged
```

Also update the cleanup effect (line ~889-896) to use the new Set:
```typescript
useEffect(() => {
	return () => {
		for (const controller of activeControllersRef.current) {
			controller.abort();
		}
		activeControllersRef.current.clear();
		invoke("stop_system_audio_capture").catch(() => {});
	};
}, []);
```

#### 7. Reset sequence counter on startCapture
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: In `startCapture`, after setting up the new conversation:

```typescript
// Reset sequence counter for new session
sequenceRef.current = 0;
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `npx tsc --noEmit`
- [x] No lint errors (no biome configured — N/A)
- [x] App builds: `npm run build`

#### Manual Verification:
- [ ] Speak 3 sentences rapidly → translations appear in spoken order (not STT completion order)
- [ ] Stop capture mid-translation → no stale result appears after restart
- [ ] Queue 5+ utterances → oldest are dropped, latest are processed
- [ ] Quick actions still work correctly (they bypass the queue)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Target Language UX and Prompt Fix

### Overview
Add a target language setting and wire it into the Meeting Translator prompt so the model knows what language to translate into.

### Changes Required:

#### 1. Add `targetLanguage` state to AppContext
**File**: `src/contexts/app.context.tsx`
**Changes**: Add `targetLanguage` state alongside `sttLanguage`, persisted to localStorage.

Add storage key in `src/config/constants.ts`:
```typescript
TARGET_LANGUAGE: "target_language",
```

In the context provider, add state:
```typescript
const [targetLanguage, setTargetLanguageState] = useState<string>(() => {
	return safeLocalStorage.getItem(STORAGE_KEYS.TARGET_LANGUAGE) || "en";
});

const setTargetLanguage = useCallback((language: string) => {
	setTargetLanguageState(language);
	safeLocalStorage.setItem(STORAGE_KEYS.TARGET_LANGUAGE, language);
}, []);
```

Expose in context value and type definition.

#### 2. Add type definition
**File**: `src/types/context.type.ts`
**Changes**: Add to the context type:
```typescript
targetLanguage: string;
setTargetLanguage: (language: string) => void;
```

#### 3. Update Meeting Translator prompt to interpolate target language
**File**: `src/config/constants.ts`
**Changes**: Make the Meeting Translator prompt a function that accepts target language:

```typescript
export const getMeetingTranslatorPrompt = (targetLanguage: string): string => {
	const languageNames: Record<string, string> = {
		en: "English",
		it: "Italian",
		es: "Spanish",
		fr: "French",
		de: "German",
		pt: "Portuguese",
		zh: "Chinese",
		ja: "Japanese",
		ko: "Korean",
		ar: "Arabic",
		ru: "Russian",
		nl: "Dutch",
		pl: "Polish",
		tr: "Turkish",
	};
	const targetName = languageNames[targetLanguage] || "English";

	return `You are a real-time meeting interpreter. Your sole job is to translate speech into ${targetName} accurately and immediately.

Rules:
- Translate what was said into ${targetName}. Do not summarize, comment, or add your own thoughts.
- Preserve the speaker's tone and intent (formal, casual, urgent, etc.).
- If a phrase is ambiguous, translate the most likely meaning in context.
- For proper nouns, company names, and technical terms, keep the original alongside a translation if helpful.
- Keep translations concise — the user is reading in real-time during a live meeting.
- If the input is already in ${targetName}, pass it through unchanged.
- Never say "I don't understand" or ask clarifying questions — just translate what you received.`;
};
```

Keep the static `DEFAULT_SYSTEM_PROMPTS` array for seeding, but use "English" as the default:
```typescript
export const DEFAULT_SYSTEM_PROMPTS = [
	{
		name: "General Assistant",
		prompt: DEFAULT_SYSTEM_PROMPT,
	},
	{
		name: "Meeting Translator",
		prompt: getMeetingTranslatorPrompt("en"),
	},
];
```

#### 4. Add target language picker to the overlay header
**File**: `src/pages/app/components/speech/index.tsx`
**Changes**: Add a second language selector next to the source language picker. Label it clearly.

After the existing source language `<Select>`, add:
```tsx
{/* Target Language Selector */}
{!setupRequired && (
	<Select value={targetLanguage} onValueChange={setTargetLanguage}>
		<SelectTrigger className="h-6 w-auto text-[10px] gap-1 px-2 min-w-0">
			<span className="text-[9px] text-muted-foreground">→</span>
			<SelectValue placeholder="English" />
		</SelectTrigger>
		<SelectContent>
			<SelectItem value="en" className="text-xs">English</SelectItem>
			<SelectItem value="it" className="text-xs">Italian</SelectItem>
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

Destructure from context:
```typescript
const { targetLanguage, setTargetLanguage } = useApp();
```

#### 5. Wire target language into the effective system prompt
**File**: `src/hooks/useSystemAudio.ts`
**Changes**: Import `getMeetingTranslatorPrompt` and `targetLanguage` from context. When the active system prompt is the Meeting Translator, dynamically rebuild it with the current target language.

In the `speech-detected` handler, where `effectiveSystemPrompt` is computed:
```typescript
const { targetLanguage } = useApp(); // already destructured at hook level
```

Add `targetLanguage` to the destructured context values (line ~128-136).

Then update the effective prompt computation to check if the current prompt matches the Meeting Translator pattern and inject the target language. The simplest approach: check if the prompt contains "real-time meeting interpreter" and replace it:

```typescript
let effectiveSystemPrompt = useSystemPrompt
	? systemPrompt || DEFAULT_SYSTEM_PROMPT
	: contextContent || DEFAULT_SYSTEM_PROMPT;

// If using Meeting Translator, rebuild with current target language
if (effectiveSystemPrompt.includes("real-time meeting interpreter")) {
	effectiveSystemPrompt = getMeetingTranslatorPrompt(targetLanguage);
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `npx tsc --noEmit`
- [x] No lint errors (no biome configured — N/A)
- [x] App builds: `npm run build`

#### Manual Verification:
- [ ] Target language picker appears in overlay header with arrow indicator
- [ ] Set target to Italian, select Meeting Translator prompt, speak English → get Italian translation
- [ ] Change target language mid-session → next translation uses new target
- [ ] Default target is English (correct for the UK-based director use case)
- [ ] Non-translator prompts are unaffected by target language setting

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Rust Bandpass Filter Fixes

### Overview
Fix the bandpass filter to persist state across chunks and handle edge cases correctly.

### Changes Required:

#### 1. Make bandpass filter stateful across chunks
**File**: `src-tauri/src/speaker/commands.rs`
**Changes**: Replace the standalone `bandpass_filter_speech` function with a stateful `BandpassFilter` struct that persists filter coefficients and previous sample state across calls.

```rust
/// Stateful bandpass filter for human speech frequencies (300-3000 Hz).
/// Persists filter state across audio chunks to avoid edge artifacts.
struct BandpassFilter {
    alpha_high: f32,
    alpha_low: f32,
    prev_input: f32,
    prev_high: f32,
    prev_low: f32,
}

impl BandpassFilter {
    fn new(sample_rate: u32) -> Self {
        let dt = 1.0 / sample_rate as f32;

        let rc_high = 1.0 / (2.0 * std::f32::consts::PI * 300.0);
        let alpha_high = rc_high / (rc_high + dt);

        let rc_low = 1.0 / (2.0 * std::f32::consts::PI * 3000.0);
        let alpha_low = dt / (rc_low + dt);

        Self {
            alpha_high,
            alpha_low,
            prev_input: 0.0,
            prev_high: 0.0,
            prev_low: 0.0,
        }
    }

    /// Filter a chunk of samples in-place into the output slice.
    /// Maintains state between calls for correct frequency response.
    fn process(&mut self, samples: &[f32], output: &mut [f32]) {
        for (i, &sample) in samples.iter().enumerate() {
            // High-pass
            let high = self.alpha_high * (self.prev_high + sample - self.prev_input);
            self.prev_input = sample;
            self.prev_high = high;

            // Low-pass
            let low = self.prev_low + self.alpha_low * (high - self.prev_low);
            self.prev_low = low;

            output[i] = low;
        }
    }
}
```

#### 2. Use the stateful filter in `run_vad_capture`
**File**: `src-tauri/src/speaker/commands.rs`
**Changes**: Create a `BandpassFilter` instance before the main loop and reuse it. Replace the `bandpass_filter_speech(&mono, sr)` call.

In `run_vad_capture`, after the variable declarations:
```rust
let mut bandpass = BandpassFilter::new(sr);
let mut vad_buffer = vec![0.0f32; config.hop_size];
```

Replace:
```rust
let mono_for_vad = bandpass_filter_speech(&mono, sr);
```

With:
```rust
bandpass.process(&mono, &mut vad_buffer);
let (rms, peak) = calculate_audio_metrics(&vad_buffer);
```

And remove the old `calculate_audio_metrics(&mono_for_vad)` call since we now pass `&vad_buffer` directly.

#### 3. Remove the old standalone function
**File**: `src-tauri/src/speaker/commands.rs`
**Changes**: Delete the `bandpass_filter_speech` function entirely (lines 364-400). It's replaced by the `BandpassFilter` struct.

### Success Criteria:

#### Automated Verification:
- [x] Rust compiles: `cd src-tauri && cargo check`
- [x] No clippy warnings: `cd src-tauri && cargo clippy`
- [x] App builds: `npm run build`

#### Manual Verification:
- [ ] VAD still detects speech correctly (no regression from filter change)
- [ ] No audio artifacts or missed detections compared to before
- [ ] Extended capture session (>1 min) doesn't show filter degradation

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Fix Hardcoded Sample Rate in VadAdvancedSettings

### Overview
Replace the hardcoded `44100` with the actual sample rate, fetched from the Rust backend on mount.

### Changes Required:

#### 1. Fetch sample rate and pass to VadAdvancedSettings
**File**: `src/pages/dev/index.tsx`
**Changes**: Fetch the actual sample rate on mount using the existing `get_audio_sample_rate` Tauri command (already exists at `commands.rs:640-650`).

```typescript
const [sampleRate, setSampleRate] = useState<number>(44100); // Safe fallback

useEffect(() => {
	invoke<number>("get_audio_sample_rate")
		.then(setSampleRate)
		.catch(() => {
			// Fallback to 44100 if no audio device available
			console.debug("Could not fetch sample rate, using 44100 default");
		});
}, []);
```

Pass to the component:
```tsx
<VadAdvancedSettings
	vadConfig={vadConfig}
	onUpdateVadConfig={updateVadConfig}
	sampleRate={sampleRate}
/>
```

#### 2. Accept and use sampleRate prop
**File**: `src/pages/dev/components/VadAdvancedSettings.tsx`
**Changes**: Add `sampleRate` to the props interface and use it in the computation.

```typescript
interface VadAdvancedSettingsProps {
	vadConfig: VadConfig;
	onUpdateVadConfig: (config: VadConfig) => void;
	sampleRate: number;
}
```

Replace the hardcoded calculation:
```typescript
const minSpeechDurationMs = Math.round(
	(vadConfig.min_speech_chunks * vadConfig.hop_size) / 44100 * 1000,
);
```

With:
```typescript
const minSpeechDurationMs = Math.round(
	(vadConfig.min_speech_chunks * vadConfig.hop_size) / sampleRate * 1000,
);
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `npx tsc --noEmit`
- [x] No lint errors (N/A — no biome configured)
- [x] App builds: `npm run build`

#### Manual Verification:
- [ ] Dev Space VAD settings show correct ms values
- [ ] Values update correctly when adjusting sliders
- [ ] If audio device is unavailable, falls back to 44100 without error

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Integration Tests:
- Rapid-fire 3 utterances → all 3 translations appear in correct order
- Stop mid-queue → restart → no stale translations appear
- Switch target language mid-session → next translation uses new language

### Edge Cases:
- Empty audio chunk reaches bandpass filter → no panic
- Queue fills to MAX_QUEUE_SIZE → oldest dropped, newest processed
- STT times out → session continues, no orphaned state
- Audio device disconnected → sample rate fallback works

## Performance Considerations

- `BandpassFilter::process` does no allocation — operates on a pre-allocated buffer
- Queue sort is O(n log n) but n is capped at 5, so effectively constant
- `activeControllersRef` Set operations are O(1)
- Target language lookup is a simple object property access

## References

- Original implementation plan: `thoughts/shared/plans/2026-03-05-meeting-translation-improvements.md`
- Core pipeline: `src/hooks/useSystemAudio.ts`
- Rust VAD: `src-tauri/src/speaker/commands.rs`
- App context: `src/contexts/app.context.tsx`
- Overlay UI: `src/pages/app/components/speech/index.tsx`
