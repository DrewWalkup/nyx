# Structured STT Return Type Implementation Plan

## Overview

`fetchSTT` currently returns a plain `string` for all outcomes — successful transcription, empty transcription, and error messages. This means callers cannot distinguish between "the user said something" and "the STT provider found no speech." When VAD triggers on a non-speech sound (click, notification, etc.), the STT provider returns nothing, `fetchSTT` returns `"No transcription found"`, and that string gets submitted to the AI as if the user said it.

We fix this by changing `fetchSTT` to return `{ transcription: string | null }`, where `null` explicitly means "no speech detected." TypeScript enforces that every caller handles this case.

## Current State Analysis

### The broken contract (`stt.function.ts`):
- **Line 251-253**: When the STT provider returns empty text, `fetchSTT` returns the string `"No transcription found"` — indistinguishable from real speech.
- **Line 28-31** (`fetchNyxSTT`): On failure, returns error strings like `"Transcription failed"` or `"Nyx STT Error: ..."` — also indistinguishable from real speech.
- **Line 241-244**: When JSON parsing fails, returns raw `responseText` — could be an error page rendered as "speech."

### Callers with bugs:
1. **`AutoSpeechVad.tsx:78`**: `if (transcription)` — truthy check passes for `"No transcription found"`, submits it to AI.
2. **`useSystemAudio.ts:346`**: `if (transcription.trim())` — same problem, sends `"No transcription found"` to `processWithAI`.
3. **`AudioRecorder.tsx:164`**: `onTranscriptionComplete(text)` — no check at all, passes everything through. Less critical since it's user-initiated, but still wrong.

## Desired End State

- `fetchSTT` returns `{ transcription: string | null }`.
- `null` means "no speech detected" — callers silently discard.
- Non-null means actual transcription text — callers use it.
- Errors remain thrown as exceptions (no change).
- All 3 callers handle `null` correctly.
- TypeScript compilation passes with no errors.

### Key Verification:
- VAD triggers on a non-speech sound → STT returns empty → `fetchSTT` returns `{ transcription: null }` → caller discards silently → nothing sent to AI.

## What We're NOT Doing

- Not changing VAD sensitivity thresholds or configuration
- Not adding audio duration filtering or pre-STT checks
- Not changing the error handling contract (errors still throw)
- Not modifying the STT provider curl/request logic
- Not touching TTS or AI response logic

## Implementation Approach

Single phase — the type change and caller updates are tightly coupled and must ship together.

## Phase 1: Structured Return Type + Caller Updates

### Overview
Change `fetchSTT` return type from `string` to `STTResult`, update `fetchNyxSTT`, and fix all 3 callers.

### Changes Required:

#### 1. `fetchSTT` and `fetchNyxSTT` return type
**File**: `src/lib/functions/stt.function.ts`

Add the result type and update the export:

```typescript
export interface STTResult {
  transcription: string | null;
}
```

Update `fetchNyxSTT` (lines 14-38) to return `STTResult`:

```typescript
async function fetchNyxSTT(audio: File | Blob): Promise<STTResult> {
  try {
    const audioBase64 = await blobToBase64(audio);

    const response = await invoke<{
      success: boolean;
      transcription?: string;
      error?: string;
    }>("transcribe_audio", {
      audioBase64,
    });

    if (response.success && response.transcription) {
      return { transcription: response.transcription };
    } else {
      throw new Error(response.error || "Transcription failed");
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Nyx STT Error: ${errorMessage}`);
  }
}
```

Key changes to `fetchNyxSTT`:
- Returns `STTResult` instead of `string`
- On success: returns `{ transcription: response.transcription }`
- On failure: **throws** instead of returning error strings — this aligns with how `fetchSTT` already handles errors (catch block at line 257-260)

Update `fetchSTT` signature and return paths (lines 53-261):

```typescript
export async function fetchSTT(params: STTParams): Promise<STTResult> {
```

Return path changes within `fetchSTT`:
- **Line 62-63** (Nyx API path): `return await fetchNyxSTT(audio);` — already returns `STTResult` after the change above.
- **Lines 241-244** (JSON parse failure with raw text):
  ```typescript
  // Raw text response — treat as transcription if non-empty
  const rawTranscription = responseText.trim();
  return { transcription: rawTranscription || null };
  ```
- **Lines 251-253** (empty transcription after path extraction):
  ```typescript
  if (!transcription) {
    return { transcription: null };
  }
  ```
- **Line 256** (successful transcription):
  ```typescript
  return { transcription };
  ```

Remove the `warnings` array (line 54) — it's initialized but never populated (the only code that could add to it is commented out on lines 86-88). This is dead code.

#### 2. AutoSpeechVad caller
**File**: `src/pages/app/components/completion/AutoSpeechVad.tsx`

Update `onSpeechEnd` (lines 72-79):

```typescript
setIsTranscribing(true);

const sttResult = await fetchSTT({
  provider: useNyxAPI ? undefined : providerConfig,
  selectedProvider: selectedSttProvider,
  audio: audioBlob,
});

if (sttResult.transcription) {
  submit(sttResult.transcription);
}
```

The `.transcription` property is `string | null` — the truthy check now works correctly because `null` is falsy.

#### 3. useSystemAudio caller
**File**: `src/hooks/useSystemAudio.ts`

Update speech-detected handler (lines 319-378):

```typescript
const sttResult = await Promise.race([
  sttPromise,
  timeoutPromise,
]);

if (sttResult.transcription) {
  if (isDuplicateTranscription(sttResult.transcription)) {
    console.debug(
      "Skipping duplicate transcription:",
      sttResult.transcription.substring(0, 50),
    );
    return;
  }

  setLastTranscription(sttResult.transcription);
  setError("");

  const effectiveSystemPrompt =
    useSystemPrompt
      ? systemPrompt || DEFAULT_SYSTEM_PROMPT
      : contextContent || DEFAULT_SYSTEM_PROMPT;

  const previousMessages =
    conversation.messages.map((msg) => {
      return {
        role: msg.role,
        content: msg.content,
      };
    });

  await processWithAI(
    sttResult.transcription,
    effectiveSystemPrompt,
    previousMessages,
  );
} else {
  // No speech detected — silently discard, don't show error
  console.debug("VAD triggered but no speech detected, discarding");
}
```

Key changes:
- Variable renamed from `transcription` to `sttResult`
- Access via `.transcription` property
- The `else` branch changes from `setError("Received empty transcription")` to a silent `console.debug` — this is the whole point: non-speech VAD triggers should not produce errors.

Also update the `timeoutPromise` type (line 326) to match:
```typescript
const timeoutPromise = new Promise<STTResult>(
  (_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            "Speech transcription timed out (30s)",
          ),
        ),
      30000,
    );
  },
);
```

And add the import at the top:
```typescript
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
```
This import already exists — just ensure `STTResult` is also exported from the barrel if needed (it's part of `stt.function.ts` which is re-exported via `src/lib/functions/index.ts`).

#### 4. AudioRecorder caller
**File**: `src/pages/chats/components/AudioRecorder.tsx`

Update `handleSend` (lines 157-164):

```typescript
const sttResult = await fetchSTT({
  provider: useNyxAPI ? undefined : provider,
  selectedProvider: selectedSttProvider,
  audio: audioBlob,
  language: sttLanguage,
});

if (sttResult.transcription) {
  onTranscriptionComplete(sttResult.transcription);
} else {
  onCancel();
}
```

When the user manually records but STT finds no speech, we cancel rather than sending empty text.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes with no errors related to `STTResult`, `fetchSTT`, or any caller
- [x] No references to the old string return type remain in callers (search for `transcription = await fetchSTT` should find zero results — all should be `sttResult = await fetchSTT`)
- [x] The string `"No transcription found"` does not appear anywhere in the codebase

#### Manual Verification:
- [ ] VAD mode: Make a non-speech sound (clap, click) near the mic → nothing is sent to the AI, no error shown
- [ ] VAD mode: Speak a sentence → transcription is submitted to the AI normally
- [ ] System audio VAD: Same two tests via the system audio capture flow
- [ ] Manual AudioRecorder: Record silence or noise → recorder cancels, nothing sent
- [ ] Manual AudioRecorder: Record speech → transcription completes normally
- [ ] Nyx API path (if applicable): Same behavior — no speech returns null, errors throw

## References

- `src/lib/functions/stt.function.ts` — fetchSTT and fetchNyxSTT
- `src/pages/app/components/completion/AutoSpeechVad.tsx` — VAD caller
- `src/hooks/useSystemAudio.ts` — system audio caller
- `src/pages/chats/components/AudioRecorder.tsx` — manual recorder caller
- `src/lib/functions/index.ts` — barrel export
