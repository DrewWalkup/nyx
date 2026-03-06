import { useState, useCallback, useEffect } from "react";
import {
  AIProviders,
  STTProviders,
  ShowThinkingToggle,
  VadAdvancedSettings,
} from "./components";
import Contribute from "@/components/Contribute";
import { useSettings } from "@/hooks";
import { DEFAULT_VAD_CONFIG, type VadConfig } from "@/hooks/useSystemAudio";
import { PageLayout } from "@/layouts";
import { safeLocalStorage } from "@/lib";
import { invoke } from "@tauri-apps/api/core";

const DevSpace = () => {
  const settings = useSettings();

  const [sampleRate, setSampleRate] = useState<number>(44100);

  useEffect(() => {
    invoke<number>("get_audio_sample_rate")
      .then(setSampleRate)
      .catch(() => {
        console.debug("Could not fetch sample rate, using 44100 default");
      });
  }, []);

  const [vadConfig, setVadConfig] = useState<VadConfig>(() => {
    const saved = safeLocalStorage.getItem("vad_config");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // Fall through to default
      }
    }
    return DEFAULT_VAD_CONFIG;
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

  return (
    <PageLayout title="Dev Space" description="Manage your dev space">
      <Contribute />
      {/* Provider Selection */}
      <AIProviders {...settings} />

      {/* STT Providers */}
      <STTProviders {...settings} />

      {/* Reasoning Model Settings */}
      <ShowThinkingToggle />

      {/* VAD Advanced Settings */}
      <VadAdvancedSettings
        vadConfig={vadConfig}
        onUpdateVadConfig={updateVadConfig}
        sampleRate={sampleRate}
      />
    </PageLayout>
  );
};

export default DevSpace;
