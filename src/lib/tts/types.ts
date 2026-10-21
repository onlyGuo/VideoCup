export interface SpeechVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  description?: string;
  styles?: { id: string; name: string }[];
}
export interface SpeechConfig {
  providerId: string;
  endpoint: string;
  voicesEndpoint: string;
  key: string;
  model: string;
  voice: string;
  language: string;
  style: string;
  rate: number;
  pitch: number;
  volume: number;
}
export interface SpeechRequest {
  text: string;
  voice: string;
  language: string;
  style: string;
  rate: number;
  pitch: number;
  volume: number;
}
export interface SpeechAudio {
  blob: Blob;
  extension: "mp3" | "wav" | "ogg";
}
export interface SpeechProvider {
  id: string;
  name: string;
  description: string;
  website?: string;
  unavailableReason?: string;
  capabilities: {
    model: boolean;
    language: boolean;
    style: boolean;
    pitch: boolean;
    volume: boolean;
  };
  listVoices(
    config: SpeechConfig,
    signal?: AbortSignal,
  ): Promise<SpeechVoice[]>;
  synthesize(
    request: SpeechRequest,
    config: SpeechConfig,
    signal?: AbortSignal,
  ): Promise<SpeechAudio>;
}
