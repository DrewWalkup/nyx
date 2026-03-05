import { Header, Selection } from "@/components";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { CustomProviders } from "./CustomProvider";
import { useApp } from "@/contexts";

const STT_LANGUAGES = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "zh", label: "Chinese" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "it", label: "Italian" },
] as const;

export const STTProviders = (settings: UseSettingsReturn) => {
  const { sttLanguage, setSttLanguage } = useApp();

  return (
    <div id="stt-providers" className="space-y-3">
      <Header
        title="STT Providers"
        description="Select your preferred STT service provider to get started."
        isMainTitle
      />

      {/* Custom Provider */}
      <CustomProviders {...settings} />
      {/* Providers Selection */}
      <Providers {...settings} />

      {/* STT Language Selection */}
      <div className="space-y-2">
        <Header
          title="STT Language"
          description="Select the language for speech-to-text transcription. Auto-detect lets the provider determine the language automatically."
        />
        <Selection
          selected={sttLanguage}
          options={STT_LANGUAGES.map((language) => ({
            label: language.label,
            value: language.code,
          }))}
          placeholder="Select language"
          onChange={(value: string) => setSttLanguage(value)}
        />
      </div>
    </div>
  );
};
