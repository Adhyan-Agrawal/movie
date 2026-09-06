/**
 * Hand-written `Database` type stub (Section 6).
 *
 * This mirrors the shape produced by `supabase gen types typescript` closely
 * enough to type our queries without a live project. It covers migration 0001
 * (identity/RBAC + core catalog) plus the most frequently queried tables from
 * 0003 (playback/engagement/ops). Each table carries `Row`/`Insert`/`Update`
 * and an (empty) `Relationships` tuple so it satisfies supabase-js's
 * `GenericSchema` constraint and gives real, non-`any` query typing.
 *
 * Replace this file wholesale once the schema stabilises:
 *   supabase gen types typescript --project-id <ref> --schema public > src/lib/supabase/types.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type TitleTypeEnum = 'movie' | 'tv';
export type TitleStatusEnum = 'draft' | 'scheduled' | 'published' | 'archived';
export type TitleVisibilityEnum = 'public' | 'private';
export type MediaSourceKindEnum =
  | 'mp4'
  | 'hls'
  | 'dash'
  | 'youtube'
  | 'vimeo'
  | 'dailymotion'
  | 'vsembed'
  | 'iframe'
  | 'embed'
  | 'custom';
export type SourceHealthEnum = 'unknown' | 'healthy' | 'degraded' | 'down';
export type ReviewStatusEnum = 'pending' | 'approved' | 'rejected';
export type CommentStatusEnum = 'visible' | 'pending' | 'hidden' | 'removed';
export type NotificationKindEnum =
  | 'system'
  | 'availability'
  | 'episode'
  | 'moderation'
  | 'security'
  | 'import';
export type ImportKindEnum = 'csv' | 'json' | 'tmdb';
export type ImportStatusEnum =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'partial';
export type WebhookStatusEnum = 'received' | 'processed' | 'failed' | 'skipped';
export type AuditOutcomeEnum = 'success' | 'failure';
export type AdFormatEnum =
  | 'preroll'
  | 'midroll'
  | 'postroll'
  | 'display'
  | 'native'
  | 'banner'
  | 'house';
export type AdEventTypeEnum =
  | 'impression'
  | 'click'
  | 'complete'
  | 'skip'
  | 'error';

export interface Database {
  public: {
    Tables: {
      accounts: {
        Row: {
          id: string;
          display_name: string;
          is_suspended: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string;
          is_suspended?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string;
          is_suspended?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      roles: {
        Row: { id: string; key: string; name: string; created_at: string };
        Insert: { id?: string; key: string; name: string; created_at?: string };
        Update: { id?: string; key?: string; name?: string; created_at?: string };
        Relationships: [];
      };
      permissions: {
        Row: { id: string; key: string; description: string };
        Insert: { id?: string; key: string; description?: string };
        Update: { id?: string; key?: string; description?: string };
        Relationships: [];
      };
      role_permissions: {
        Row: { role_id: string; permission_id: string };
        Insert: { role_id: string; permission_id: string };
        Update: { role_id?: string; permission_id?: string };
        Relationships: [];
      };
      account_members: {
        Row: { account_id: string; role_id: string; created_at: string };
        Insert: { account_id: string; role_id: string; created_at?: string };
        Update: { account_id?: string; role_id?: string; created_at?: string };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          account_id: string;
          name: string;
          avatar: string | null;
          maturity_ceiling: string;
          is_kids: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          account_id: string;
          name: string;
          avatar?: string | null;
          maturity_ceiling?: string;
          is_kids?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          account_id?: string;
          name?: string;
          avatar?: string | null;
          maturity_ceiling?: string;
          is_kids?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      genres: {
        Row: { id: string; slug: string; name: string };
        Insert: { id?: string; slug: string; name: string };
        Update: { id?: string; slug?: string; name?: string };
        Relationships: [];
      };
      titles: {
        Row: {
          id: string;
          type: TitleTypeEnum;
          tmdb_id: number | null;
          imdb_id: string | null;
          slug: string;
          name: string;
          original_name: string | null;
          synopsis: string;
          release_year: number | null;
          runtime_minutes: number | null;
          maturity: string;
          status: TitleStatusEnum;
          visibility: TitleVisibilityEnum;
          original_language: string;
          poster_url: string | null;
          backdrop_url: string | null;
          trailer_url: string | null;
          featured: boolean;
          editorial_score: number | null;
          published_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          type: TitleTypeEnum;
          tmdb_id?: number | null;
          imdb_id?: string | null;
          slug: string;
          name: string;
          original_name?: string | null;
          synopsis?: string;
          release_year?: number | null;
          runtime_minutes?: number | null;
          maturity?: string;
          status?: TitleStatusEnum;
          visibility?: TitleVisibilityEnum;
          original_language?: string;
          poster_url?: string | null;
          backdrop_url?: string | null;
          trailer_url?: string | null;
          featured?: boolean;
          editorial_score?: number | null;
          published_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['titles']['Insert']>;
        Relationships: [];
      };
      title_genres: {
        Row: { title_id: string; genre_id: string };
        Insert: { title_id: string; genre_id: string };
        Update: { title_id?: string; genre_id?: string };
        Relationships: [];
      };
      seasons: {
        Row: {
          id: string;
          title_id: string;
          season_number: number;
          name: string | null;
          overview: string;
          air_date: string | null;
          poster_url: string | null;
          episode_count: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title_id: string;
          season_number: number;
          name?: string | null;
          overview?: string;
          air_date?: string | null;
          poster_url?: string | null;
          episode_count?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['seasons']['Insert']>;
        Relationships: [];
      };
      episodes: {
        Row: {
          id: string;
          title_id: string;
          season_id: string | null;
          season_number: number | null;
          episode_number: number;
          name: string;
          overview: string;
          air_date: string | null;
          runtime_minutes: number | null;
          still_url: string | null;
          tmdb_id: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title_id: string;
          season_id?: string | null;
          season_number?: number | null;
          episode_number: number;
          name: string;
          overview?: string;
          air_date?: string | null;
          runtime_minutes?: number | null;
          still_url?: string | null;
          tmdb_id?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['episodes']['Insert']>;
        Relationships: [];
      };
      providers: {
        Row: {
          id: string;
          key: string;
          name: string;
          adapter: string;
          enabled: boolean;
          base_url: string | null;
          allowed_domains: string[];
          movie_path_template: string | null;
          series_path_template: string | null;
          episode_path_template: string | null;
          shorthand_episode_template: string | null;
          priority: number;
          timeout_ms: number;
          enabled_regions: string[];
          consent_required: boolean;
          test_title_id: string | null;
          config: Json;
          health: SourceHealthEnum;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          key: string;
          name: string;
          adapter?: string;
          enabled?: boolean;
          base_url?: string | null;
          allowed_domains?: string[];
          movie_path_template?: string | null;
          series_path_template?: string | null;
          episode_path_template?: string | null;
          shorthand_episode_template?: string | null;
          priority?: number;
          timeout_ms?: number;
          enabled_regions?: string[];
          consent_required?: boolean;
          test_title_id?: string | null;
          config?: Json;
          health?: SourceHealthEnum;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['providers']['Insert']>;
        Relationships: [];
      };
      media_sources: {
        Row: {
          id: string;
          title_id: string;
          episode_id: string | null;
          provider_id: string | null;
          kind: MediaSourceKindEnum;
          url: string | null;
          reference: string | null;
          label: string;
          language: string;
          quality: string;
          priority: number;
          is_default: boolean;
          enabled: boolean;
          consent_required: boolean;
          geo_policy: Json;
          safe_headers: Json;
          health: SourceHealthEnum;
          last_checked_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title_id: string;
          episode_id?: string | null;
          provider_id?: string | null;
          kind: MediaSourceKindEnum;
          url?: string | null;
          reference?: string | null;
          label?: string;
          language?: string;
          quality?: string;
          priority?: number;
          is_default?: boolean;
          enabled?: boolean;
          consent_required?: boolean;
          geo_policy?: Json;
          safe_headers?: Json;
          health?: SourceHealthEnum;
          last_checked_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['media_sources']['Insert']>;
        Relationships: [];
      };
      watch_progress: {
        Row: {
          id: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          episode_id: string | null;
          position_seconds: number;
          duration_seconds: number | null;
          progress: number;
          completed: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          episode_id?: string | null;
          position_seconds?: number;
          duration_seconds?: number | null;
          progress?: number;
          completed?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['watch_progress']['Insert']>;
        Relationships: [];
      };
      watchlists: {
        Row: {
          id: string;
          profile_id: string;
          account_id: string;
          name: string;
          is_default: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          account_id: string;
          name?: string;
          is_default?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['watchlists']['Insert']>;
        Relationships: [];
      };
      watchlist_items: {
        Row: {
          watchlist_id: string;
          title_id: string;
          sort_order: number;
          added_at: string;
        };
        Insert: {
          watchlist_id: string;
          title_id: string;
          sort_order?: number;
          added_at?: string;
        };
        Update: Partial<Database['public']['Tables']['watchlist_items']['Insert']>;
        Relationships: [];
      };
      ratings: {
        Row: {
          id: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          value: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          value: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['ratings']['Insert']>;
        Relationships: [];
      };
      reviews: {
        Row: {
          id: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          body: string;
          rating: number | null;
          status: ReviewStatusEnum;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          body: string;
          rating?: number | null;
          status?: ReviewStatusEnum;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['reviews']['Insert']>;
        Relationships: [];
      };
      recent_searches: {
        Row: {
          id: string;
          profile_id: string;
          account_id: string;
          query: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          account_id: string;
          query: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['recent_searches']['Insert']>;
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          account_id: string;
          profile_id: string | null;
          kind: NotificationKindEnum;
          title: string;
          body: string;
          data: Json;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          account_id: string;
          profile_id?: string | null;
          kind?: NotificationKindEnum;
          title: string;
          body?: string;
          data?: Json;
          read_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['notifications']['Insert']>;
        Relationships: [];
      };
      site_settings: {
        Row: {
          key: string;
          value: Json;
          is_public: boolean;
          description: string;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          key: string;
          value?: Json;
          is_public?: boolean;
          description?: string;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['site_settings']['Insert']>;
        Relationships: [];
      };
      feature_flags: {
        Row: {
          key: string;
          enabled: boolean;
          description: string;
          is_public: boolean;
          rollout: Json;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          key: string;
          enabled?: boolean;
          description?: string;
          is_public?: boolean;
          rollout?: Json;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['feature_flags']['Insert']>;
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: string;
          actor_account_id: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          reason: string | null;
          outcome: AuditOutcomeEnum;
          before: Json | null;
          after: Json | null;
          ip: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          actor_account_id?: string | null;
          action: string;
          entity_type?: string | null;
          entity_id?: string | null;
          reason?: string | null;
          outcome?: AuditOutcomeEnum;
          before?: Json | null;
          after?: Json | null;
          ip?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['audit_logs']['Insert']>;
        Relationships: [];
      };
      people: {
        Row: {
          id: string;
          tmdb_id: number | null;
          name: string;
          known_for: string | null;
          biography: string;
          birthday: string | null;
          profile_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          tmdb_id?: number | null;
          name: string;
          known_for?: string | null;
          biography?: string;
          birthday?: string | null;
          profile_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['people']['Insert']>;
        Relationships: [];
      };
      title_people: {
        Row: {
          id: string;
          title_id: string;
          person_id: string;
          credit_type: string;
          character: string | null;
          job: string | null;
          department: string | null;
          credit_order: number;
        };
        Insert: {
          id?: string;
          title_id: string;
          person_id: string;
          credit_type: string;
          character?: string | null;
          job?: string | null;
          department?: string | null;
          credit_order?: number;
        };
        Update: Partial<Database['public']['Tables']['title_people']['Insert']>;
        Relationships: [];
      };
      collections: {
        Row: {
          id: string;
          slug: string;
          name: string;
          description: string;
          kind: string;
          is_public: boolean;
          sort_order: number;
          published_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          description?: string;
          kind?: string;
          is_public?: boolean;
          sort_order?: number;
          published_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['collections']['Insert']>;
        Relationships: [];
      };
      collection_items: {
        Row: {
          collection_id: string;
          title_id: string;
          sort_order: number;
          added_at: string;
        };
        Insert: {
          collection_id: string;
          title_id: string;
          sort_order?: number;
          added_at?: string;
        };
        Update: Partial<
          Database['public']['Tables']['collection_items']['Insert']
        >;
        Relationships: [];
      };
      tags: {
        Row: { id: string; slug: string; name: string; created_at: string };
        Insert: { id?: string; slug: string; name: string; created_at?: string };
        Update: Partial<Database['public']['Tables']['tags']['Insert']>;
        Relationships: [];
      };
      title_tags: {
        Row: { title_id: string; tag_id: string };
        Insert: { title_id: string; tag_id: string };
        Update: Partial<Database['public']['Tables']['title_tags']['Insert']>;
        Relationships: [];
      };
      subtitle_tracks: {
        Row: {
          id: string;
          source_id: string | null;
          title_id: string;
          language: string;
          label: string | null;
          kind: string;
          url: string | null;
          is_default: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          source_id?: string | null;
          title_id: string;
          language: string;
          label?: string | null;
          kind?: string;
          url?: string | null;
          is_default?: boolean;
          created_at?: string;
        };
        Update: Partial<
          Database['public']['Tables']['subtitle_tracks']['Insert']
        >;
        Relationships: [];
      };
      audio_tracks: {
        Row: {
          id: string;
          source_id: string | null;
          title_id: string;
          language: string;
          label: string | null;
          channels: string | null;
          is_default: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          source_id?: string | null;
          title_id: string;
          language: string;
          label?: string | null;
          channels?: string | null;
          is_default?: boolean;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['audio_tracks']['Insert']>;
        Relationships: [];
      };
      playback_sessions: {
        Row: {
          id: string;
          account_id: string;
          profile_id: string | null;
          title_id: string;
          episode_id: string | null;
          source_id: string | null;
          provider_id: string | null;
          device: string | null;
          state: string;
          started_at: string;
          ended_at: string | null;
          last_heartbeat_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          account_id: string;
          profile_id?: string | null;
          title_id: string;
          episode_id?: string | null;
          source_id?: string | null;
          provider_id?: string | null;
          device?: string | null;
          state?: string;
          started_at?: string;
          ended_at?: string | null;
          last_heartbeat_at?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database['public']['Tables']['playback_sessions']['Insert']
        >;
        Relationships: [];
      };
      comments: {
        Row: {
          id: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          parent_id: string | null;
          body: string;
          status: CommentStatusEnum;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          profile_id: string;
          account_id: string;
          title_id: string;
          parent_id?: string | null;
          body: string;
          status?: CommentStatusEnum;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['comments']['Insert']>;
        Relationships: [];
      };
      imports: {
        Row: {
          id: string;
          kind: ImportKindEnum;
          status: ImportStatusEnum;
          source: string | null;
          mapping: Json;
          dry_run: boolean;
          total: number;
          processed: number;
          succeeded: number;
          failed: number;
          error_report: Json;
          idempotency_key: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          kind: ImportKindEnum;
          status?: ImportStatusEnum;
          source?: string | null;
          mapping?: Json;
          dry_run?: boolean;
          total?: number;
          processed?: number;
          succeeded?: number;
          failed?: number;
          error_report?: Json;
          idempotency_key?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['imports']['Insert']>;
        Relationships: [];
      };
      webhook_events: {
        Row: {
          id: string;
          provider: string;
          event_id: string;
          event_type: string | null;
          payload: Json;
          signature: string | null;
          status: WebhookStatusEnum;
          processed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          provider: string;
          event_id: string;
          event_type?: string | null;
          payload?: Json;
          signature?: string | null;
          status?: WebhookStatusEnum;
          processed_at?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database['public']['Tables']['webhook_events']['Insert']
        >;
        Relationships: [];
      };
      health_checks: {
        Row: {
          id: string;
          component: string;
          status: SourceHealthEnum;
          latency_ms: number | null;
          detail: Json;
          checked_at: string;
        };
        Insert: {
          id?: string;
          component: string;
          status?: SourceHealthEnum;
          latency_ms?: number | null;
          detail?: Json;
          checked_at?: string;
        };
        Update: Partial<Database['public']['Tables']['health_checks']['Insert']>;
        Relationships: [];
      };
      ad_providers: {
        Row: {
          id: string;
          key: string;
          name: string;
          enabled: boolean;
          config: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          key: string;
          name: string;
          enabled?: boolean;
          config?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['ad_providers']['Insert']>;
        Relationships: [];
      };
      ad_placements: {
        Row: {
          id: string;
          key: string;
          name: string;
          format: AdFormatEnum;
          position: string | null;
          enabled: boolean;
          device_targeting: Json;
          frequency_cap: number | null;
          cooldown_seconds: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          key: string;
          name: string;
          format: AdFormatEnum;
          position?: string | null;
          enabled?: boolean;
          device_targeting?: Json;
          frequency_cap?: number | null;
          cooldown_seconds?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['ad_placements']['Insert']>;
        Relationships: [];
      };
      ad_campaigns: {
        Row: {
          id: string;
          provider_id: string | null;
          name: string;
          enabled: boolean;
          consent_required: boolean;
          starts_at: string | null;
          ends_at: string | null;
          kill_switch: boolean;
          revenue_meta: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          provider_id?: string | null;
          name: string;
          enabled?: boolean;
          consent_required?: boolean;
          starts_at?: string | null;
          ends_at?: string | null;
          kill_switch?: boolean;
          revenue_meta?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['ad_campaigns']['Insert']>;
        Relationships: [];
      };
      ad_creatives: {
        Row: {
          id: string;
          campaign_id: string;
          placement_id: string | null;
          format: AdFormatEnum;
          asset_url: string | null;
          click_url: string | null;
          html: string | null;
          enabled: boolean;
          weight: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          campaign_id: string;
          placement_id?: string | null;
          format: AdFormatEnum;
          asset_url?: string | null;
          click_url?: string | null;
          html?: string | null;
          enabled?: boolean;
          weight?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['ad_creatives']['Insert']>;
        Relationships: [];
      };
      ad_events: {
        Row: {
          id: string;
          creative_id: string | null;
          placement_id: string | null;
          campaign_id: string | null;
          account_id: string | null;
          profile_id: string | null;
          type: AdEventTypeEnum;
          meta: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          creative_id?: string | null;
          placement_id?: string | null;
          campaign_id?: string | null;
          account_id?: string | null;
          profile_id?: string | null;
          type: AdEventTypeEnum;
          meta?: Json;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['ad_events']['Insert']>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      has_permission: {
        Args: { perm_key: string };
        Returns: boolean;
      };
    };
    Enums: {
      title_type: TitleTypeEnum;
      title_status: TitleStatusEnum;
      title_visibility: TitleVisibilityEnum;
      media_source_kind: MediaSourceKindEnum;
      source_health: SourceHealthEnum;
      review_status: ReviewStatusEnum;
      comment_status: CommentStatusEnum;
      notification_kind: NotificationKindEnum;
      import_kind: ImportKindEnum;
      import_status: ImportStatusEnum;
      webhook_status: WebhookStatusEnum;
      audit_outcome: AuditOutcomeEnum;
      ad_format: AdFormatEnum;
      ad_event_type: AdEventTypeEnum;
    };
    CompositeTypes: Record<never, never>;
  };
}

/** Convenience helpers for consumers. */
export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
