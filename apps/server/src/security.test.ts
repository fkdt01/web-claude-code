import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServerSecurityConfig,
  isApiRequestAuthorized,
  isCorsOriginAllowed,
  isPublicBindHost
} from "./security.js";

test("server defaults to local bind and local web origins", () => {
  const config = buildServerSecurityConfig({});

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.publicBind, false);
  assert.deepEqual(config.corsOrigins, ["http://localhost:5173", "http://127.0.0.1:5173"]);
});

test("public bind requires an API token unless explicitly marked unsafe", () => {
  assert.equal(isPublicBindHost("0.0.0.0"), true);
  assert.throws(() => buildServerSecurityConfig({ HOST: "0.0.0.0" }), /API_AUTH_TOKEN/);

  const config = buildServerSecurityConfig({ HOST: "0.0.0.0", API_AUTH_TOKEN: "secret" });
  assert.equal(config.publicBind, true);
  assert.equal(config.apiAuthToken, "secret");
});

test("CORS defaults reject arbitrary browser origins", () => {
  const config = buildServerSecurityConfig({});

  assert.equal(isCorsOriginAllowed(undefined, config.corsOrigins), true);
  assert.equal(isCorsOriginAllowed("http://localhost:5173", config.corsOrigins), true);
  assert.equal(isCorsOriginAllowed("https://example.invalid", config.corsOrigins), false);
});

test("API token auth accepts bearer or explicit header", () => {
  assert.equal(isApiRequestAuthorized({}, undefined), true);
  assert.equal(isApiRequestAuthorized({ authorization: "Bearer secret" }, "secret"), true);
  assert.equal(isApiRequestAuthorized({ "x-webcode-token": "secret" }, "secret"), true);
  assert.equal(isApiRequestAuthorized({ authorization: "Bearer wrong" }, "secret"), false);
});
