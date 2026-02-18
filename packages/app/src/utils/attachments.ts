import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system';
import { Alert } from 'react-native';

// -- Types --

export interface Attachment {
  id: string;
  type: 'image' | 'document';
  uri: string;
  name: string;
  mediaType: string;
  /** Base64-encoded file data (cleared after send to free memory) */
  data: string | null;
  size: number;
}

// -- Constants --

/** Max image dimension (pixels) — images larger than this are resized by expo-image-picker */
export const MAX_IMAGE_DIMENSION = 1536;
/** JPEG compression quality (0–1) */
export const IMAGE_QUALITY = 0.7;
/** Max file size after compression (bytes) */
export const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB
/** Max document size (bytes) */
export const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024; // 5MB
/** Max attachments per message */
export const MAX_ATTACHMENTS = 5;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const SUPPORTED_DOC_TYPES = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'];

let attachmentCounter = 0;
function nextAttachmentId(): string {
  return `att-${++attachmentCounter}-${Date.now()}`;
}

// -- Pickers --

export async function pickFromCamera(): Promise<Attachment | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    Alert.alert('Permission needed', 'Camera access is required to take photos.');
    return null;
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: IMAGE_QUALITY,
    base64: true,
    exif: false,
  });

  if (result.canceled || !result.assets?.[0]) return null;
  return assetToAttachment(result.assets[0]);
}

export async function pickFromGallery(): Promise<Attachment | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert('Permission needed', 'Photo library access is required.');
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: IMAGE_QUALITY,
    base64: true,
    exif: false,
  });

  if (result.canceled || !result.assets?.[0]) return null;
  return assetToAttachment(result.assets[0]);
}

export async function pickDocument(): Promise<Attachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...SUPPORTED_DOC_TYPES, ...SUPPORTED_IMAGE_TYPES],
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const mimeType = asset.mimeType || 'application/octet-stream';

  // If it's an image, handle like an image
  if (SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    const base64 = await readAsStringAsync(asset.uri, {
      encoding: 'base64',
    });
    const size = base64.length * 0.75; // approximate decoded size
    if (size > MAX_IMAGE_SIZE) {
      Alert.alert('File too large', `Image must be under ${Math.round(MAX_IMAGE_SIZE / 1024 / 1024)}MB.`);
      return null;
    }
    return {
      id: nextAttachmentId(),
      type: 'image',
      uri: asset.uri,
      name: asset.name || 'image',
      mediaType: mimeType,
      data: base64,
      size,
    };
  }

  // Document
  if (!SUPPORTED_DOC_TYPES.includes(mimeType)) {
    Alert.alert('Unsupported file', 'Only images, PDFs, and text files are supported.');
    return null;
  }

  const base64 = await readAsStringAsync(asset.uri, {
    encoding: 'base64',
  });
  const size = base64.length * 0.75;
  if (size > MAX_DOCUMENT_SIZE) {
    Alert.alert('File too large', `Documents must be under ${Math.round(MAX_DOCUMENT_SIZE / 1024 / 1024)}MB.`);
    return null;
  }

  return {
    id: nextAttachmentId(),
    type: 'document',
    uri: asset.uri,
    name: asset.name || 'document',
    mediaType: mimeType,
    data: base64,
    size,
  };
}

// -- Helpers --

function assetToAttachment(asset: ImagePicker.ImagePickerAsset): Attachment | null {
  if (!asset.base64) return null;

  const size = asset.base64.length * 0.75;
  if (size > MAX_IMAGE_SIZE) {
    Alert.alert('Image too large', `Image must be under ${Math.round(MAX_IMAGE_SIZE / 1024 / 1024)}MB after compression.`);
    return null;
  }

  const mimeType = asset.mimeType || (asset.uri.endsWith('.png') ? 'image/png' : 'image/jpeg');
  const fileName = asset.fileName || asset.uri.split('/').pop() || 'photo.jpg';

  return {
    id: nextAttachmentId(),
    type: 'image',
    uri: asset.uri,
    name: fileName,
    mediaType: mimeType,
    data: asset.base64,
    size,
  };
}

/** Format file size for display */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Build the wire-format attachments array for the WebSocket message */
export function toWireAttachments(attachments: Attachment[]): { type: string; mediaType: string; data: string; name: string }[] {
  return attachments
    .filter((a) => a.data != null)
    .map((a) => ({
      type: a.type,
      mediaType: a.mediaType,
      data: a.data!,
      name: a.name,
    }));
}
