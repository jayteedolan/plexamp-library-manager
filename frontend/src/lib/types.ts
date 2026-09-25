export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  kind: "dir" | "audio" | "image" | "file";
}

export interface Listing {
  path: string;
  entries: FsEntry[];
}

export interface AudioInfo {
  format: string;
  duration: number;
  bitrate: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
  title: string | null;
  track: string | null;
  disc: string | null;
  date: string | null;
  genre: string | null;
  quality: string;
}

export interface FileInfo extends FsEntry {
  file_count?: number;
  audio?: AudioInfo | null;
}

export interface Conflict {
  name: string;
  existing: { is_dir: boolean; size: number; mtime: number; quality: string | null };
  incoming: { is_dir: boolean; size: number; mtime: number; quality: string | null };
}

export interface Operation {
  id: string;
  kind: "copy" | "move";
  total_bytes: number;
  done_bytes: number;
  current: string;
  finished: boolean;
  cancelled: boolean;
  error: string | null;
  results: { source: string; status: string; target?: string; renamed?: boolean; reason?: string }[];
}

export interface TrashItem {
  id: string;
  name: string;
  original_path: string;
  is_dir: boolean;
  size: number;
  deleted_at: string;
}

export interface ResultFile {
  filename: string;
  name: string;
  size: number;
  ext: string;
  bitrate: number | null;
  bit_depth: number | null;
  sample_rate: number | null;
  length: number | null;
  is_audio: boolean;
  tier: number | null;
  quality: string | null;
  locked: boolean;
}

export interface ResultGroup {
  id: string;
  username: string;
  directory: string;
  folder_name: string;
  parent_name: string | null;
  has_free_slot: boolean;
  upload_speed: number;
  queue_length: number;
  files: ResultFile[];
  tier: number;
  tier_name: string;
  quality: string;
  mixed: boolean;
  audio_count: number;
  total_size: number;
  audio_size: number;
  locked: boolean;
  in_library: "full" | "partial" | null;
}

export interface SearchResults {
  complete: boolean;
  state: string;
  response_count: number;
  groups: ResultGroup[];
}

export interface SearchSource {
  key: string;
  label: string;
  ok: boolean;
  message: string;
}

export type FileState = "queued" | "downloading" | "completed" | "failed" | "cancelled";
export type JobStatus = "active" | "ready" | "cancelled" | "filed" | "failed" | "discarded";

export interface JobFile {
  id: number;
  name: string;
  size: number;
  state: FileState;
  remote_state: string | null;
  place_in_queue: number | null;
  bytes_transferred: number;
  speed: number;
  error: string | null;
  filed: boolean;
  local_path: string | null;
}

export interface Job {
  id: number;
  provider: string;
  username: string;
  remote_folder: string;
  title: string;
  status: JobStatus;
  filed_path: string | null;
  created_at: string;
  updated_at: string;
  total_bytes: number;
  done_bytes: number;
  speed: number;
  eta_seconds: number | null;
  counts: Record<FileState, number>;
  unfiled_completed: number;
  files: JobFile[];
}

export interface Suggestion {
  artist: string | null;
  album: string | null;
  path: string;
  exists: boolean;
  source: "tags" | "folder";
  confident: boolean;
}

export interface SystemStatus {
  storage: {
    ok: boolean;
    reason: string | null;
    disk: { total: number; used: number; free: number } | null;
    fs_type: string;
  };
  trash_size: number;
  soulseek: { ok: boolean; message: string };
  downloads: { active: number; ready: number; awaiting_decision: number };
  library_index: { source: string; albums: number };
}

export interface PlexSection {
  id: string;
  title: string;
  type: string;
  refreshing: boolean;
  locations: string[];
  scanned_at: number | null;
}

export interface PlexStatus {
  configured: boolean;
  ok: boolean;
  message: string;
  version?: string;
  section?: PlexSection | null;
  refreshing?: boolean;
  counts?: { artists: number; albums: number; tracks: number } | null;
  last_scan_requested: string | null;
  last_scan_path: string | null;
}

export interface AuthStatus {
  setup_required: boolean;
  authenticated: boolean;
  username: string | null;
  auth_enabled: boolean;
}

export interface SettingsView {
  slskd_url: string;
  slskd_api_key_set: boolean;
  plex_url: string;
  plex_token_set: boolean;
  plex_section_id: string;
  plex_library_path: string;
  trash_retention_days: number;
}
