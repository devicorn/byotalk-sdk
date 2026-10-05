// Creates a fresh org + project through the dashboard sign-in flow (dev magic link); returns its development env id.
async function json(res: Response) {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function createDevEnv(api: string, name = "SDK call tests"): Promise<string> {
  const email = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const link = await json(await fetch(`${api}/v1/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }));
  const token = new URL(link.devLink).searchParams.get("token");
  const verify = await fetch(`${api}/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
  const h = { cookie, "x-byotalk-dashboard": "1", "content-type": "application/json" };
  const me = await json(await fetch(`${api}/v1/auth/me`, { headers: h }));
  const project = await json(await fetch(`${api}/v1/dashboard/orgs/${me.orgs[0].id}/projects`, { method: "POST", headers: h, body: JSON.stringify({ name }) }));
  return project.environments.find((e: { kind: string }) => e.kind === "development").id;
}
