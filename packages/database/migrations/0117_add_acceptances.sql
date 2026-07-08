CREATE TABLE IF NOT EXISTS "acceptance_report_runs" (
	"report_id" uuid NOT NULL,
	"verify_run_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"role" text,
	"sort_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acceptance_report_runs_report_id_verify_run_id_pk" PRIMARY KEY("report_id","verify_run_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptance_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"acceptance_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"root_verify_run_id" uuid,
	"final_verify_run_id" uuid,
	"verdict" text,
	"overall_confidence" numeric(3, 2),
	"total_checks" integer,
	"passed_checks" integer,
	"failed_checks" integer,
	"uncertain_checks" integer,
	"summary" text,
	"content" text,
	"reviewed_by_user" boolean DEFAULT false,
	"metadata" jsonb,
	"generated_by" text DEFAULT 'system',
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requirement" text,
	"config" jsonb DEFAULT '{}'::jsonb,
	"root_verify_run_id" uuid,
	"current_verify_run_id" uuid,
	"final_verify_run_id" uuid,
	"latest_report_id" uuid,
	"metadata" jsonb,
	"completed_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verify_runs" ADD COLUMN IF NOT EXISTS "acceptance_id" uuid;--> statement-breakpoint
ALTER TABLE "verify_runs" ADD COLUMN IF NOT EXISTS "round_index" integer;--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" DROP CONSTRAINT IF EXISTS "acceptance_report_runs_report_id_acceptance_reports_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" ADD CONSTRAINT "acceptance_report_runs_report_id_acceptance_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."acceptance_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" DROP CONSTRAINT IF EXISTS "acceptance_report_runs_verify_run_id_verify_runs_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" ADD CONSTRAINT "acceptance_report_runs_verify_run_id_verify_runs_id_fk" FOREIGN KEY ("verify_run_id") REFERENCES "public"."verify_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" DROP CONSTRAINT IF EXISTS "acceptance_report_runs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" ADD CONSTRAINT "acceptance_report_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" DROP CONSTRAINT IF EXISTS "acceptance_report_runs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_report_runs" ADD CONSTRAINT "acceptance_report_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_reports" DROP CONSTRAINT IF EXISTS "acceptance_reports_acceptance_id_acceptances_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_reports" ADD CONSTRAINT "acceptance_reports_acceptance_id_acceptances_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "public"."acceptances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_reports" DROP CONSTRAINT IF EXISTS "acceptance_reports_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_reports" ADD CONSTRAINT "acceptance_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_reports" DROP CONSTRAINT IF EXISTS "acceptance_reports_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_reports" ADD CONSTRAINT "acceptance_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_reports" DROP CONSTRAINT IF EXISTS "acceptance_reports_root_verify_run_id_verify_runs_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_reports" ADD CONSTRAINT "acceptance_reports_root_verify_run_id_verify_runs_id_fk" FOREIGN KEY ("root_verify_run_id") REFERENCES "public"."verify_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_reports" DROP CONSTRAINT IF EXISTS "acceptance_reports_final_verify_run_id_verify_runs_id_fk";--> statement-breakpoint
ALTER TABLE "acceptance_reports" ADD CONSTRAINT "acceptance_reports_final_verify_run_id_verify_runs_id_fk" FOREIGN KEY ("final_verify_run_id") REFERENCES "public"."verify_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptances" DROP CONSTRAINT IF EXISTS "acceptances_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "acceptances" ADD CONSTRAINT "acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptances" DROP CONSTRAINT IF EXISTS "acceptances_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "acceptances" ADD CONSTRAINT "acceptances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_report_runs_verify_run_id_idx" ON "acceptance_report_runs" USING btree ("verify_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_report_runs_user_id_idx" ON "acceptance_report_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_report_runs_workspace_id_idx" ON "acceptance_report_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_reports_acceptance_id_version_unique" ON "acceptance_reports" USING btree ("acceptance_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_reports_acceptance_id_idx" ON "acceptance_reports" USING btree ("acceptance_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_reports_user_id_idx" ON "acceptance_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_reports_workspace_id_idx" ON "acceptance_reports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_reports_root_verify_run_id_idx" ON "acceptance_reports" USING btree ("root_verify_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_reports_final_verify_run_id_idx" ON "acceptance_reports" USING btree ("final_verify_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_user_id_idx" ON "acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_workspace_id_idx" ON "acceptances" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_subject_idx" ON "acceptances" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_status_idx" ON "acceptances" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_root_verify_run_id_idx" ON "acceptances" USING btree ("root_verify_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_current_verify_run_id_idx" ON "acceptances" USING btree ("current_verify_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_final_verify_run_id_idx" ON "acceptances" USING btree ("final_verify_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptances_latest_report_id_idx" ON "acceptances" USING btree ("latest_report_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptances_personal_subject_unique" ON "acceptances" USING btree ("user_id","subject_type","subject_id") WHERE "acceptances"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptances_workspace_subject_unique" ON "acceptances" USING btree ("workspace_id","subject_type","subject_id") WHERE "acceptances"."workspace_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "verify_runs" DROP CONSTRAINT IF EXISTS "verify_runs_acceptance_id_acceptances_id_fk";--> statement-breakpoint
ALTER TABLE "verify_runs" ADD CONSTRAINT "verify_runs_acceptance_id_acceptances_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "public"."acceptances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_runs_acceptance_id_idx" ON "verify_runs" USING btree ("acceptance_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verify_runs_acceptance_round_unique" ON "verify_runs" USING btree ("acceptance_id","round_index");
