import { ColorScheme, StartScreenPrompt, ThemeOption } from "@openai/chatkit";

export const WORKFLOW_ID =
  process.env.NEXT_PUBLIC_CHATKIT_WORKFLOW_ID?.trim() ?? "";

export const CREATE_SESSION_ENDPOINT = "/api/create-session";

export const STARTER_PROMPTS: StartScreenPrompt[] = [
  {
    label: "পানির বিষয়ে কিছু জানতে চান?",
    prompt: "How can you help with my drinking water?",
    icon: "circle-question",
  },
];

export const PLACEHOLDER_INPUT = "কি জানতে চান...";

export const GREETING = "💧 স্বাগতম! আমি পানীয় জল সম্পর্কে জানতে সাহায্য করি।\n⚠️ আমি একটি স্বয়ংক্রিয়-বট, তাই সব কথা নিখুঁত নাও হতে পারে।";

export const getThemeConfig = (theme: ColorScheme): ThemeOption => ({
  color: {
    grayscale: {
      hue: 220,
      tint: 6,
      shade: theme === "dark" ? -1 : -4,
    },
    accent: {
      primary: theme === "dark" ? "#f1f5f9" : "#0f172a",
      level: 1,
    },
  },
  radius: "round",
  // Add other theme options here
  // chatkit.studio/playground to explore config options
});
