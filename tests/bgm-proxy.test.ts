import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeBgmImageUrls,
  proxyCacheKey,
  resolveProxyPolicy,
} from "@/lib/bgm/proxy-policy";

test("只放行插件需要的只读路径", () => {
  assert.ok(resolveProxyPolicy(["calendar"], "GET"));
  assert.ok(resolveProxyPolicy(["v0", "episodes"], "GET"));
  assert.ok(resolveProxyPolicy(["v0", "search", "subjects"], "POST"));
  assert.ok(resolveProxyPolicy(["v0", "subjects", "8"], "GET"));
  assert.ok(resolveProxyPolicy(["v0", "subjects", "8", "characters"], "GET"));
  assert.ok(resolveProxyPolicy(["v0", "subjects", "8", "persons"], "GET"));
  assert.ok(resolveProxyPolicy(["v0", "subjects", "8", "subjects"], "GET"));
});

test("拒绝写接口、用户接口、路径穿越与非法 id", () => {
  assert.equal(resolveProxyPolicy(["v0", "me"], "GET"), null);
  assert.equal(resolveProxyPolicy(["v0", "users", "-", "collections"], "POST"), null);
  assert.equal(resolveProxyPolicy(["v0", "subjects", "8"], "POST"), null);
  assert.equal(resolveProxyPolicy(["v0", "subjects", "08"], "GET"), null);
  assert.equal(resolveProxyPolicy(["v0", "subjects", "8", "episodes"], "GET"), null);
  assert.equal(resolveProxyPolicy(["..", "calendar"], "GET"), null);
  assert.equal(resolveProxyPolicy(["calendar", ""], "GET"), null);
  assert.equal(resolveProxyPolicy([], "GET"), null);
});

test("缓存 TTL：周历短、条目长、搜索不缓存", () => {
  assert.equal(resolveProxyPolicy(["calendar"], "GET")?.ttlMs, 6 * 60 * 60 * 1000);
  assert.equal(resolveProxyPolicy(["v0", "subjects", "8"], "GET")?.ttlMs, 24 * 60 * 60 * 1000);
  assert.equal(resolveProxyPolicy(["v0", "search", "subjects"], "POST")?.ttlMs, 0);
});

test("缓存键对查询参数顺序不敏感", () => {
  const a = proxyCacheKey(["v0", "episodes"], new URLSearchParams("subject_id=8&limit=100"));
  const b = proxyCacheKey(["v0", "episodes"], new URLSearchParams("limit=100&subject_id=8"));
  assert.equal(a, b);
  assert.notEqual(a, proxyCacheKey(["v0", "episodes"], new URLSearchParams("subject_id=9&limit=100")));
});

test("图片地址统一升级 https，其他字符串不动", () => {
  const input = {
    images: {
      large: "http://lain.bgm.tv/pic/cover/l/1.jpg",
      common: "https://lain.bgm.tv/pic/cover/c/1.jpg",
    },
    url: "http://bgm.tv/subject/8",
    name: "http 不是图片地址",
    list: ["http://lain.bgm.tv/a.jpg"],
  };
  const output = normalizeBgmImageUrls(input);
  assert.equal(output.images.large, "https://lain.bgm.tv/pic/cover/l/1.jpg");
  assert.equal(output.images.common, "https://lain.bgm.tv/pic/cover/c/1.jpg");
  assert.equal(output.url, "https://bgm.tv/subject/8");
  assert.equal(output.name, "http 不是图片地址");
  assert.equal(output.list[0], "https://lain.bgm.tv/a.jpg");
});
