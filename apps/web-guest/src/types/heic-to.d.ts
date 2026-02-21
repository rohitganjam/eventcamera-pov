declare module 'heic-to' {
  interface HeicToOptions {
    blob: Blob;
    type?: string;
    quality?: number;
  }

  export function heicTo(options: HeicToOptions): Promise<Blob>;
}
