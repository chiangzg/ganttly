CREATE TABLE "external_references" (
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_references_pkey" PRIMARY KEY("workspace_id","provider","external_id","entity_type"),
	CONSTRAINT "external_references_entity_type_check" CHECK ("external_references"."entity_type" in ('project', 'task'))
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_access_tokens_token_prefix_idx" ON "personal_access_tokens" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "personal_access_tokens_user_created_idx" ON "personal_access_tokens" USING btree ("user_id","created_at" DESC NULLS LAST);