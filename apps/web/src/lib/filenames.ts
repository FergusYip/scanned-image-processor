export function fileStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(0, index) : base;
}

export function cropFileName(fileName: string, index: number, total: number): string {
  const stem = fileStem(fileName).replace(/[^\w.-]+/g, "_") || "crop";
  return total === 1 ? `${stem}.jpg` : `${stem}_${index}.jpg`;
}

export function uniqueZipName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let counter = 2;
  let candidate = `${stem}_${counter}${ext}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem}_${counter}${ext}`;
  }
  used.add(candidate);
  return candidate;
}
