export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      biomarkers: {
        Row: {
          category: Database["public"]["Enums"]["biomarker_category"]
          created_at: string
          description: string | null
          higher_is_better: boolean | null
          id: string
          name: string
          notes: string | null
          optimal_range_high: number | null
          optimal_range_low: number | null
          slug: string
          standard_range_high: number | null
          standard_range_low: number | null
          unit: string | null
          updated_at: string
        }
        Insert: {
          category?: Database["public"]["Enums"]["biomarker_category"]
          created_at?: string
          description?: string | null
          higher_is_better?: boolean | null
          id?: string
          name: string
          notes?: string | null
          optimal_range_high?: number | null
          optimal_range_low?: number | null
          slug: string
          standard_range_high?: number | null
          standard_range_low?: number | null
          unit?: string | null
          updated_at?: string
        }
        Update: {
          category?: Database["public"]["Enums"]["biomarker_category"]
          created_at?: string
          description?: string | null
          higher_is_better?: boolean | null
          id?: string
          name?: string
          notes?: string | null
          optimal_range_high?: number | null
          optimal_range_low?: number | null
          slug?: string
          standard_range_high?: number | null
          standard_range_low?: number | null
          unit?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      body_metrics: {
        Row: {
          body_fat_pct: number | null
          bone_mass_kg: number | null
          created_at: string
          hip_cm: number | null
          id: string
          measured_at: string
          muscle_mass_kg: number | null
          notes: string | null
          source: Database["public"]["Enums"]["data_source"]
          updated_at: string
          user_id: string
          visceral_fat_rating: number | null
          waist_cm: number | null
          weight_kg: number | null
        }
        Insert: {
          body_fat_pct?: number | null
          bone_mass_kg?: number | null
          created_at?: string
          hip_cm?: number | null
          id?: string
          measured_at: string
          muscle_mass_kg?: number | null
          notes?: string | null
          source?: Database["public"]["Enums"]["data_source"]
          updated_at?: string
          user_id: string
          visceral_fat_rating?: number | null
          waist_cm?: number | null
          weight_kg?: number | null
        }
        Update: {
          body_fat_pct?: number | null
          bone_mass_kg?: number | null
          created_at?: string
          hip_cm?: number | null
          id?: string
          measured_at?: string
          muscle_mass_kg?: number | null
          notes?: string | null
          source?: Database["public"]["Enums"]["data_source"]
          updated_at?: string
          user_id?: string
          visceral_fat_rating?: number | null
          waist_cm?: number | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "body_metrics_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_logs: {
        Row: {
          created_at: string
          date: string
          id: string
          notes: string | null
          overall_adherence_score: number | null
          summary: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          date: string
          id?: string
          notes?: string | null
          overall_adherence_score?: number | null
          summary?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          date?: string
          id?: string
          notes?: string | null
          overall_adherence_score?: number | null
          summary?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_reports: {
        Row: {
          collected_at: string
          created_at: string
          file_path: string | null
          id: string
          notes: string | null
          parsed_at: string | null
          raw_extracted_json: Json | null
          source: Database["public"]["Enums"]["data_source"]
          updated_at: string
          user_id: string
        }
        Insert: {
          collected_at: string
          created_at?: string
          file_path?: string | null
          id?: string
          notes?: string | null
          parsed_at?: string | null
          raw_extracted_json?: Json | null
          source?: Database["public"]["Enums"]["data_source"]
          updated_at?: string
          user_id: string
        }
        Update: {
          collected_at?: string
          created_at?: string
          file_path?: string | null
          id?: string
          notes?: string | null
          parsed_at?: string | null
          raw_extracted_json?: Json | null
          source?: Database["public"]["Enums"]["data_source"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_reports_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      lab_results: {
        Row: {
          biomarker_id: string
          collected_at: string
          created_at: string
          id: string
          lab_name: string | null
          notes: string | null
          report_id: string | null
          source: Database["public"]["Enums"]["data_source"]
          updated_at: string
          user_id: string
          value: number
        }
        Insert: {
          biomarker_id: string
          collected_at: string
          created_at?: string
          id?: string
          lab_name?: string | null
          notes?: string | null
          report_id?: string | null
          source?: Database["public"]["Enums"]["data_source"]
          updated_at?: string
          user_id: string
          value: number
        }
        Update: {
          biomarker_id?: string
          collected_at?: string
          created_at?: string
          id?: string
          lab_name?: string | null
          notes?: string | null
          report_id?: string | null
          source?: Database["public"]["Enums"]["data_source"]
          updated_at?: string
          user_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "lab_results_biomarker_id_fkey"
            columns: ["biomarker_id"]
            isOneToOne: false
            referencedRelation: "biomarkers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_results_report_fk"
            columns: ["report_id", "user_id"]
            isOneToOne: false
            referencedRelation: "lab_reports"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "lab_results_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      log_entries: {
        Row: {
          completed_at: string | null
          created_at: string
          daily_log_id: string
          id: string
          notes: string | null
          protocol_id: string | null
          scheduled_time: string | null
          source: Database["public"]["Enums"]["data_source"]
          status: Database["public"]["Enums"]["log_entry_status"]
          title: string
          type: Database["public"]["Enums"]["log_entry_type"]
          updated_at: string
          user_id: string
          value: Json | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          daily_log_id: string
          id?: string
          notes?: string | null
          protocol_id?: string | null
          scheduled_time?: string | null
          source?: Database["public"]["Enums"]["data_source"]
          status?: Database["public"]["Enums"]["log_entry_status"]
          title: string
          type: Database["public"]["Enums"]["log_entry_type"]
          updated_at?: string
          user_id: string
          value?: Json | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          daily_log_id?: string
          id?: string
          notes?: string | null
          protocol_id?: string | null
          scheduled_time?: string | null
          source?: Database["public"]["Enums"]["data_source"]
          status?: Database["public"]["Enums"]["log_entry_status"]
          title?: string
          type?: Database["public"]["Enums"]["log_entry_type"]
          updated_at?: string
          user_id?: string
          value?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "log_entries_daily_log_fk"
            columns: ["daily_log_id", "user_id"]
            isOneToOne: false
            referencedRelation: "daily_logs"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "log_entries_protocol_id_fkey"
            columns: ["protocol_id"]
            isOneToOne: false
            referencedRelation: "protocols"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "log_entries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      protocol_versions: {
        Row: {
          change_notes: string | null
          content: Json
          created_at: string
          created_by: Database["public"]["Enums"]["authorship"]
          id: string
          protocol_id: string
          user_id: string
          version_number: number
        }
        Insert: {
          change_notes?: string | null
          content?: Json
          created_at?: string
          created_by?: Database["public"]["Enums"]["authorship"]
          id?: string
          protocol_id: string
          user_id: string
          version_number: number
        }
        Update: {
          change_notes?: string | null
          content?: Json
          created_at?: string
          created_by?: Database["public"]["Enums"]["authorship"]
          id?: string
          protocol_id?: string
          user_id?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "protocol_versions_protocol_fk"
            columns: ["protocol_id", "user_id"]
            isOneToOne: false
            referencedRelation: "protocols"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "protocol_versions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      protocols: {
        Row: {
          created_at: string
          current_version_id: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          type: Database["public"]["Enums"]["protocol_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_version_id?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
          type: Database["public"]["Enums"]["protocol_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_version_id?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          type?: Database["public"]["Enums"]["protocol_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "protocols_current_version_fk"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "protocol_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "protocols_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          biological_sex: Database["public"]["Enums"]["biological_sex"] | null
          created_at: string
          date_of_birth: string | null
          email: string
          full_name: string | null
          id: string
          preferences: Json
          timezone: string
          updated_at: string
        }
        Insert: {
          biological_sex?: Database["public"]["Enums"]["biological_sex"] | null
          created_at?: string
          date_of_birth?: string | null
          email: string
          full_name?: string | null
          id: string
          preferences?: Json
          timezone?: string
          updated_at?: string
        }
        Update: {
          biological_sex?: Database["public"]["Enums"]["biological_sex"] | null
          created_at?: string
          date_of_birth?: string | null
          email?: string
          full_name?: string | null
          id?: string
          preferences?: Json
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      wearable_data: {
        Row: {
          created_at: string
          date: string
          end_time: string | null
          id: string
          metadata: Json
          metric_type: string
          source_device: Database["public"]["Enums"]["wearable_device"]
          source_raw_id: string | null
          start_time: string | null
          unit: string | null
          updated_at: string
          user_id: string
          value: number
        }
        Insert: {
          created_at?: string
          date: string
          end_time?: string | null
          id?: string
          metadata?: Json
          metric_type: string
          source_device: Database["public"]["Enums"]["wearable_device"]
          source_raw_id?: string | null
          start_time?: string | null
          unit?: string | null
          updated_at?: string
          user_id: string
          value: number
        }
        Update: {
          created_at?: string
          date?: string
          end_time?: string | null
          id?: string
          metadata?: Json
          metric_type?: string
          source_device?: Database["public"]["Enums"]["wearable_device"]
          source_raw_id?: string | null
          start_time?: string | null
          unit?: string | null
          updated_at?: string
          user_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "wearable_data_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      authorship: "user" | "ai"
      biological_sex: "male" | "female" | "intersex" | "prefer_not_to_say"
      biomarker_category:
        | "cardiovascular"
        | "metabolic"
        | "hormone"
        | "inflammation"
        | "nutrient"
        | "organ"
        | "immune"
        | "hematology"
        | "cancer"
        | "toxin"
        | "other"
      data_source:
        | "function_pdf"
        | "manual"
        | "api"
        | "device_sync"
        | "apple_health"
        | "health_connect"
        | "terra"
        | "ai_suggested"
        | "import"
      log_entry_status: "pending" | "completed" | "skipped" | "partial"
      log_entry_type:
        | "habit"
        | "meal"
        | "workout"
        | "supplement"
        | "medication"
        | "therapy"
        | "metric"
        | "note"
      protocol_type:
        | "daily_routine"
        | "supplement_stack"
        | "meal_template"
        | "training_block"
        | "therapy_protocol"
        | "sleep_protocol"
        | "other"
      wearable_device:
        | "oura"
        | "whoop"
        | "ultrahuman"
        | "apple_watch"
        | "garmin"
        | "eight_sleep"
        | "withings"
        | "manual"
        | "other"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      authorship: ["user", "ai"],
      biological_sex: ["male", "female", "intersex", "prefer_not_to_say"],
      biomarker_category: [
        "cardiovascular",
        "metabolic",
        "hormone",
        "inflammation",
        "nutrient",
        "organ",
        "immune",
        "hematology",
        "cancer",
        "toxin",
        "other",
      ],
      data_source: [
        "function_pdf",
        "manual",
        "api",
        "device_sync",
        "apple_health",
        "health_connect",
        "terra",
        "ai_suggested",
        "import",
      ],
      log_entry_status: ["pending", "completed", "skipped", "partial"],
      log_entry_type: [
        "habit",
        "meal",
        "workout",
        "supplement",
        "medication",
        "therapy",
        "metric",
        "note",
      ],
      protocol_type: [
        "daily_routine",
        "supplement_stack",
        "meal_template",
        "training_block",
        "therapy_protocol",
        "sleep_protocol",
        "other",
      ],
      wearable_device: [
        "oura",
        "whoop",
        "ultrahuman",
        "apple_watch",
        "garmin",
        "eight_sleep",
        "withings",
        "manual",
        "other",
      ],
    },
  },
} as const
