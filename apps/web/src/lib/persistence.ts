import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AppSettings, CropRegion, SourceImage, SourceStatus } from "../types";

const databaseName = "scanned-image-processor";
const databaseVersion = 1;
const settingsKey = "app-settings";

type PersistedSourceJson = {
  id: string;
  fileName: string;
  fileType: string;
  originalWidth: number;
  originalHeight: number;
  displayWidth: number;
  displayHeight: number;
  status: Exclude<SourceStatus, "processing">;
  crops: CropRegion[];
  selectedCropId?: string;
  batchSelected: boolean;
  error?: string;
  updatedAt: number;
};

type PersistedSourceBlob = {
  id: string;
  blob: Blob;
  updatedAt: number;
};

type PersistedSettings = {
  id: typeof settingsKey;
  value: AppSettings;
  updatedAt: number;
};

interface ScannedImageProcessorDb extends DBSchema {
  sourceJson: {
    key: string;
    value: PersistedSourceJson;
    indexes: { "by-updated-at": number };
  };
  sourceBlobs: {
    key: string;
    value: PersistedSourceBlob;
    indexes: { "by-updated-at": number };
  };
  settings: {
    key: typeof settingsKey;
    value: PersistedSettings;
  };
}

let database: Promise<IDBPDatabase<ScannedImageProcessorDb>> | undefined;

function getDatabase() {
  database ??= openDB<ScannedImageProcessorDb>(databaseName, databaseVersion, {
    upgrade(db) {
      const sourceJson = db.createObjectStore("sourceJson", { keyPath: "id" });
      sourceJson.createIndex("by-updated-at", "updatedAt");

      const sourceBlobs = db.createObjectStore("sourceBlobs", { keyPath: "id" });
      sourceBlobs.createIndex("by-updated-at", "updatedAt");

      db.createObjectStore("settings", { keyPath: "id" });
    },
  });
  return database;
}

function toPersistedSourceJson(source: SourceImage): PersistedSourceJson {
  return {
    id: source.id,
    fileName: source.fileName,
    fileType: source.fileType,
    originalWidth: source.originalWidth,
    originalHeight: source.originalHeight,
    displayWidth: source.displayWidth,
    displayHeight: source.displayHeight,
    status: source.status === "processing" ? "queued" : source.status,
    crops: source.crops,
    selectedCropId: source.selectedCropId,
    batchSelected: source.batchSelected,
    error: source.error,
    updatedAt: Date.now(),
  };
}

export async function loadPersistedState(): Promise<{ settings?: AppSettings; sources: SourceImage[] }> {
  const db = await getDatabase();
  const [settings, sourceJson] = await Promise.all([db.get("settings", settingsKey), db.getAll("sourceJson")]);
  const sources = await Promise.all(
    sourceJson.map(async (source): Promise<SourceImage | undefined> => {
      const storedBlob = await db.get("sourceBlobs", source.id);
      if (!storedBlob) return undefined;
      return {
        ...source,
        blob: storedBlob.blob,
        objectUrl: URL.createObjectURL(storedBlob.blob),
      };
    }),
  );

  return {
    settings: settings?.value,
    sources: sources.filter((source): source is SourceImage => Boolean(source)),
  };
}

export async function saveSettings(settings: AppSettings) {
  const db = await getDatabase();
  await db.put("settings", { id: settingsKey, value: settings, updatedAt: Date.now() });
}

export async function saveSource(source: SourceImage) {
  const db = await getDatabase();
  const tx = db.transaction(["sourceJson", "sourceBlobs"], "readwrite");
  const updatedAt = Date.now();
  await Promise.all([
    tx.objectStore("sourceJson").put({ ...toPersistedSourceJson(source), updatedAt }),
    tx.objectStore("sourceBlobs").put({ id: source.id, blob: source.blob, updatedAt }),
    tx.done,
  ]);
}

export async function saveSourceJson(source: SourceImage) {
  const db = await getDatabase();
  await db.put("sourceJson", toPersistedSourceJson(source));
}

export async function deleteSource(sourceId: string) {
  const db = await getDatabase();
  const tx = db.transaction(["sourceJson", "sourceBlobs"], "readwrite");
  await Promise.all([tx.objectStore("sourceJson").delete(sourceId), tx.objectStore("sourceBlobs").delete(sourceId), tx.done]);
}
