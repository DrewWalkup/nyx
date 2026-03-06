import { Label, Slider } from "@/components";
import { Header } from "@/components";
import type { VadConfig } from "@/hooks/useSystemAudio";

interface VadAdvancedSettingsProps {
  vadConfig: VadConfig;
  onUpdateVadConfig: (config: VadConfig) => void;
  sampleRate: number;
}

export const VadAdvancedSettings = ({
  vadConfig,
  onUpdateVadConfig,
  sampleRate,
}: VadAdvancedSettingsProps) => {
  const minSpeechDurationMs = Math.round(
    (vadConfig.min_speech_chunks * vadConfig.hop_size) / sampleRate * 1000,
  );

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
            {minSpeechDurationMs}ms
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
          Audio shorter than this is discarded. Increase to filter coughs and
          clicks.
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
          Higher values require louder peaks to trigger speech detection. Helps
          in noisy rooms.
        </p>
      </div>
    </div>
  );
};
