CREATE TABLE "catalog_behavior_personas" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"catalog_id" text NOT NULL,
	"persona_slug" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "catalog_behavior_personas_org_id_project_id_catalog_id_persona_slug_pk" PRIMARY KEY("org_id","project_id","catalog_id","persona_slug"),
	CONSTRAINT "catalog_behavior_personas_ordinal_check" CHECK ("catalog_behavior_personas"."ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "catalog_behavior_personas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog_behavior_relations" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"catalog_id" text NOT NULL,
	"related_catalog_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "catalog_behavior_relations_org_id_project_id_catalog_id_ordinal_pk" PRIMARY KEY("org_id","project_id","catalog_id","ordinal"),
	CONSTRAINT "catalog_behavior_relations_ordinal_check" CHECK ("catalog_behavior_relations"."ordinal" >= 0),
	CONSTRAINT "catalog_behavior_relations_no_self_check" CHECK ("catalog_behavior_relations"."catalog_id" <> "catalog_behavior_relations"."related_catalog_id")
);
--> statement-breakpoint
ALTER TABLE "catalog_behavior_relations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog_behaviors" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"catalog_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"initiative" text NOT NULL,
	"title" text NOT NULL,
	"intent" text NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"behavior_id" text NOT NULL,
	"source_path" text NOT NULL,
	"source_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_behaviors_org_id_project_id_catalog_id_pk" PRIMARY KEY("org_id","project_id","catalog_id"),
	CONSTRAINT "catalog_behaviors_schema_check" CHECK ("catalog_behaviors"."schema_version" = 'tanren.behavior.v0'),
	CONSTRAINT "catalog_behaviors_catalog_id_check" CHECK ("catalog_behaviors"."catalog_id" ~ '^B-[0-9]{4}$'),
	CONSTRAINT "catalog_behaviors_source_digest_check" CHECK ("catalog_behaviors"."source_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "catalog_behaviors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog_personas" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"schema_version" text NOT NULL,
	"name" text NOT NULL,
	"world" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"persona_id" text NOT NULL,
	"source_path" text NOT NULL,
	"source_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_personas_org_id_project_id_slug_pk" PRIMARY KEY("org_id","project_id","slug"),
	CONSTRAINT "catalog_personas_schema_check" CHECK ("catalog_personas"."schema_version" = 'tanren.persona.v0'),
	CONSTRAINT "catalog_personas_slug_check" CHECK ("catalog_personas"."slug" ~ '^[a-z][a-z0-9-]*$'),
	CONSTRAINT "catalog_personas_source_digest_check" CHECK ("catalog_personas"."source_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "catalog_personas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- `personas` has a single-column primary key, so there was no `(org_id, id)`
-- unique for a COMPOSITE same-org foreign key to reference. Create it BEFORE the
-- catalogue foreign keys below (drizzle emits every index after every constraint,
-- so this statement is hand-hoisted). A single-column FK to `personas(id)` would
-- let an org-A row point at an org-B persona; that is the hole this closes.
CREATE UNIQUE INDEX "personas_org_id_unique" ON "personas" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "catalog_behavior_personas" ADD CONSTRAINT "catalog_behavior_personas_behavior_fk" FOREIGN KEY ("org_id","project_id","catalog_id") REFERENCES "public"."catalog_behaviors"("org_id","project_id","catalog_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_behavior_personas" ADD CONSTRAINT "catalog_behavior_personas_persona_fk" FOREIGN KEY ("org_id","project_id","persona_slug") REFERENCES "public"."catalog_personas"("org_id","project_id","slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_behavior_relations" ADD CONSTRAINT "catalog_behavior_relations_source_fk" FOREIGN KEY ("org_id","project_id","catalog_id") REFERENCES "public"."catalog_behaviors"("org_id","project_id","catalog_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_behavior_relations" ADD CONSTRAINT "catalog_behavior_relations_target_fk" FOREIGN KEY ("org_id","project_id","related_catalog_id") REFERENCES "public"."catalog_behaviors"("org_id","project_id","catalog_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_behaviors" ADD CONSTRAINT "catalog_behaviors_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_behaviors" ADD CONSTRAINT "catalog_behaviors_behavior_fk" FOREIGN KEY ("behavior_id") REFERENCES "public"."behaviors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_personas" ADD CONSTRAINT "catalog_personas_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_personas" ADD CONSTRAINT "catalog_personas_persona_fk" FOREIGN KEY ("org_id","persona_id") REFERENCES "public"."personas"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_behavior_personas_org_id" ON "catalog_behavior_personas" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "catalog_behavior_personas_slug" ON "catalog_behavior_personas" USING btree ("org_id","project_id","persona_slug");--> statement-breakpoint
CREATE INDEX "catalog_behavior_relations_org_id" ON "catalog_behavior_relations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "catalog_behavior_relations_target" ON "catalog_behavior_relations" USING btree ("org_id","project_id","related_catalog_id");--> statement-breakpoint
CREATE INDEX "catalog_behaviors_org_id" ON "catalog_behaviors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "catalog_behaviors_org_project" ON "catalog_behaviors" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "catalog_personas_org_id" ON "catalog_personas" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "catalog_behavior_personas" AS PERMISSIVE FOR ALL TO public USING ("catalog_behavior_personas"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("catalog_behavior_personas"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "catalog_behavior_relations" AS PERMISSIVE FOR ALL TO public USING ("catalog_behavior_relations"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("catalog_behavior_relations"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "catalog_behaviors" AS PERMISSIVE FOR ALL TO public USING ("catalog_behaviors"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("catalog_behaviors"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "catalog_personas" AS PERMISSIVE FOR ALL TO public USING ("catalog_personas"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("catalog_personas"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
-- ===========================================================================
-- Hand-written tail: drizzle-kit emits ENABLE ROW LEVEL SECURITY and the
-- USING + WITH CHECK policy, but never FORCE ROW LEVEL SECURITY. Without FORCE
-- the table OWNER bypasses the policy, so the org boundary would hold only for
-- the restricted runtime role. The catalogue tables carry a whole product's
-- behaviour catalogue; force the boundary for every role. Idempotent.
-- ===========================================================================
ALTER TABLE "catalog_personas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_behaviors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_behavior_personas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_behavior_relations" FORCE ROW LEVEL SECURITY;
