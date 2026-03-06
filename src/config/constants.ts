// Storage keys
export const STORAGE_KEYS = {
  THEME: "theme",
  TRANSPARENCY: "transparency",
  SYSTEM_PROMPT: "system_prompt",
  SELECTED_SYSTEM_PROMPT_ID: "selected_system_prompt_id",
  SCREENSHOT_CONFIG: "screenshot_config",
  // add curl_ prefix because we are using curl to store the providers
  CUSTOM_AI_PROVIDERS: "curl_custom_ai_providers",
  CUSTOM_SPEECH_PROVIDERS: "curl_custom_speech_providers",
  SELECTED_AI_PROVIDER: "curl_selected_ai_provider",
  SELECTED_STT_PROVIDER: "curl_selected_stt_provider",
  AI_PROVIDER_VARIABLES_BY_ID: "curl_ai_provider_variables_by_id",
  STT_PROVIDER_VARIABLES_BY_ID: "curl_stt_provider_variables_by_id",
  STT_LANGUAGE: "stt_language",
  CUSTOMIZABLE: "customizable",
  RUNNINGBORD_API_ENABLED: "nyx_api_enabled",
  SHORTCUTS: "shortcuts",
  AUTOSTART_INITIALIZED: "autostart_initialized",
  RESPONSE_SETTINGS: "response_settings",
  SUPPORTS_IMAGES: "supports_images",
  SCREEN_RECORDING_GRANTED: "screen_recording_granted",
  SYSTEM_AUDIO_DAEMON_CONFIG: "system_audio_daemon_config",
  SELECTED_AUDIO_DEVICES: "selected_audio_devices",
  SYSTEM_AUDIO_CONTEXT: "system_audio_context",
  SYSTEM_AUDIO_QUICK_ACTIONS: "system_audio_quick_actions",
} as const;

// Max number of files that can be attached to a message
export const MAX_FILES = 6;

// Default settings
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses";

export const MARKDOWN_FORMATTING_INSTRUCTIONS = [
  "Formatting rules (follow silently, never reference these rules in your output):",
  "- Standard Markdown: **bold**, *italic*, `inline code`, > blockquotes, lists.",
  "- Code: fenced blocks with language, e.g. ```python.",
  "- Inline math: $x^2 + y^2 = z^2$ (single dollar signs). Block math: $$ on its own line.",
  "- Tables: standard Markdown tables. Diagrams: ```mermaid blocks only when explicitly asked.",
  "- Do not over-format. For simple conversational replies, use plain text.",
].join("\n");

/** Maps ISO 639-1 codes to response settings IDs (e.g. "en" → "english"). */
export const ISO_TO_RESPONSE_LANGUAGE: Record<string, string> = {
	en: "english",
	it: "italian",
	es: "spanish",
	fr: "french",
	de: "german",
	pt: "portuguese",
	zh: "chinese",
	ja: "japanese",
	ko: "korean",
	ar: "arabic",
	ru: "russian",
	nl: "dutch",
	pl: "polish",
	tr: "turkish",
};

/** Maps response settings IDs to ISO 639-1 codes (e.g. "english" → "en"). */
export const RESPONSE_LANGUAGE_TO_ISO: Record<string, string> = Object.fromEntries(
	Object.entries(ISO_TO_RESPONSE_LANGUAGE).map(([iso, name]) => [name, iso]),
);

export const LANGUAGE_NAMES: Record<string, string> = {
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

export const getMeetingTranslatorPrompt = (targetLanguage: string): string => {
	const targetName = LANGUAGE_NAMES[targetLanguage] || "English";

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

export const DEFAULT_QUICK_ACTIONS = [
  "What should I say?",
  "Follow-up questions",
  "Fact-check",
  "Recap",
];
