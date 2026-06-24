// Re-export of the shared SocialWorldCanvas. The implementation moved to
// shared/social-world so the clinician client can render the same world; this
// keeps existing AAC imports (the /social-world single-player route) working.
export { default, type SocialWorldNet } from "@shared/social-world/SocialWorldCanvas";
