CREATE TABLE "outbox_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"type" text NOT NULL,
	"payload_jsonb" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_events_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "project_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"request_hash" text,
	"idempotency_key" text,
	"expected_revision" bigint,
	"result_revision" bigint NOT NULL,
	"summary_jsonb" jsonb NOT NULL,
	"response_jsonb" jsonb,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_operations_actor_type_check" CHECK ("project_operations"."actor_type" in ('web', 'mcp', 'system'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"file_jsonb" jsonb NOT NULL,
	"summary_jsonb" jsonb NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"source_type" text,
	"source_client_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"display_name" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_provider_subject_unique" UNIQUE("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_members_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('owner', 'admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspaces_kind_check" CHECK ("workspaces"."kind" in ('personal', 'team'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_workspace_sequence_idx" ON "outbox_events" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "outbox_events_publish_idx" ON "outbox_events" USING btree ("published_at","sequence");--> statement-breakpoint
CREATE INDEX "project_operations_project_created_idx" ON "project_operations" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "project_operations_idempotency_unique" ON "project_operations" USING btree ("workspace_id","actor_type","actor_id","idempotency_key") WHERE "project_operations"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "projects_workspace_list_idx" ON "projects" USING btree ("workspace_id","deleted_at","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "projects_workspace_name_idx" ON "projects" USING btree ("workspace_id",lower("name"));