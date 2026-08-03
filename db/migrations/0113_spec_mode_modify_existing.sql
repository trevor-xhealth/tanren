ALTER TABLE "specs" DROP CONSTRAINT "specs_mode_check";--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_mode_check" CHECK ("specs"."mode" IN ('specialize_seed','from_scratch','modify_existing'));
