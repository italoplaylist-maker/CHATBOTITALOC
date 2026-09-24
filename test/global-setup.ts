import { execSync } from "node:child_process";

/** Banco de teste zerado e com as migrations aplicadas (só o banco de TESTE — nunca aponte para produção). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/chatbot_test";
  if (!/chatbot_test/.test(url)) throw new Error("TEST_DATABASE_URL precisa apontar para um banco de teste (nome contendo chatbot_test).");
  const env = { ...process.env, DATABASE_URL: url };
  execSync('npx prisma db execute --stdin --schema prisma/schema.prisma', { input: "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;", env, stdio: ["pipe", "ignore", "inherit"] });
  execSync("npx prisma migrate deploy", { env, stdio: "ignore" });
}
