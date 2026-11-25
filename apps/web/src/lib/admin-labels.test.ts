import { describe, expect, it } from "vitest";
import {
  actorName,
  auditActionLabel,
  changedByText,
  entityLabel,
  isAutomatedVia,
  lastChangeText,
  revisionReasonLabel,
  viaKind,
  viaLabel,
} from "./admin-labels";

describe("via labels", () => {
  it("maps every known source to a readable Uzbek label", () => {
    expect(viaLabel("web")).toBe("Veb panel");
    expect(viaLabel("mcp")).toBe("Yordamchi ulagich");
    expect(viaLabel("telegram")).toBe("Telegram");
    expect(viaLabel("scheduler")).toBe("Rejalashtiruvchi");
    expect(viaLabel("system")).toBe("Tizim");
  });

  it("never throws on unknown or missing sources", () => {
    expect(viaLabel("yangi-manba")).toBe("yangi-manba");
    expect(viaLabel(null)).toBe("Noma'lum manba");
    expect(viaLabel(undefined)).toBe("Noma'lum manba");
    expect(viaLabel("")).toBe("Noma'lum manba");
  });

  it("separates human from non-human sources", () => {
    expect(viaKind("web")).toBe("web");
    expect(viaKind("telegram")).toBe("telegram");
    for (const via of ["mcp", "scheduler", "system"]) {
      expect(viaKind(via)).toBe("automated");
      expect(isAutomatedVia(via)).toBe(true);
    }
    expect(viaKind("zzz")).toBe("unknown");
    expect(isAutomatedVia("web")).toBe(false);
    expect(isAutomatedVia("telegram")).toBe(false);
    expect(isAutomatedVia(null)).toBe(false);
  });
});

describe("who changed it", () => {
  it("falls back sensibly for a null actor", () => {
    expect(actorName(null, "scheduler")).toBe("Rejalashtiruvchi");
    expect(actorName(null, "system")).toBe("Tizim");
    expect(actorName(null, "web")).toBe("Foydalanuvchi yo'q");
    expect(actorName(null)).toBe("Foydalanuvchi yo'q");
    expect(actorName({ name: null }, "web")).toBe("Noma'lum foydalanuvchi");
    expect(actorName({ name: "Aziz" }, "mcp")).toBe("Aziz");
  });

  it("shows the source only when it is not the web panel", () => {
    expect(changedByText({ name: "Aziz" }, "web")).toBe("Aziz");
    expect(changedByText({ name: "Aziz" }, null)).toBe("Aziz");
    expect(changedByText({ name: "Aziz" }, "mcp")).toBe("Aziz · Yordamchi ulagich");
    expect(changedByText({ name: "Aziz" }, "telegram")).toBe("Aziz · Telegram");
    expect(changedByText(null, "scheduler")).toBe("Rejalashtiruvchi");
    expect(changedByText(null, "mcp")).toBe("Yordamchi ulagich");
  });

  it("lastChangeText is quiet when nothing useful is known (null updatedBy, old rows)", () => {
    expect(lastChangeText(null, null)).toBeNull();
    expect(lastChangeText(null, undefined)).toBeNull();
    expect(lastChangeText(null, "web")).toBeNull();
    expect(lastChangeText(null, "scheduler")).toBe("Rejalashtiruvchi");
    expect(lastChangeText({ name: "Aziz" }, "web")).toBe("Aziz");
    expect(lastChangeText({ name: "Aziz" }, "mcp")).toBe("Aziz · Yordamchi ulagich");
  });
});

describe("revision reasons and audit actions", () => {
  it("labels known revision reasons and passes unknown ones through", () => {
    expect(revisionReasonLabel("publish")).toBe("Chop etishdan oldin");
    expect(revisionReasonLabel("restore-revision")).toBe("Versiyaga qaytarishdan oldin");
    expect(revisionReasonLabel("update")).toBe("Tahrirdan oldingi holat");
    expect(revisionReasonLabel("kelajak-sababi")).toBe("kelajak-sababi");
    expect(revisionReasonLabel("")).toBe("Saqlangan holat");
  });

  it("labels audit actions and entities, raw code when unknown", () => {
    expect(auditActionLabel("post.restore_trash")).toBe("Savatdan tiklandi");
    expect(auditActionLabel("post.purge")).toBe("Butunlay o'chirildi");
    expect(auditActionLabel("yangi.amal")).toBe("yangi.amal");
    expect(entityLabel("post")).toBe("Post");
    expect(entityLabel("nimadir")).toBe("nimadir");
  });
});
