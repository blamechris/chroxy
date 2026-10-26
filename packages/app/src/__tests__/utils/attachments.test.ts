import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { pickDocument, toWireAttachments } from '../../utils/attachments';

// The root compatibility export throws on SDK 55. Keep it distinct from the
// functional legacy mock so changing the import back breaks this regression.
jest.mock('expo-file-system', () => ({
  readAsStringAsync: jest.fn(() => { throw new Error('Use expo-file-system/legacy'); }),
}));

const mockPick = DocumentPicker.getDocumentAsync as jest.Mock;
const mockRead = readAsStringAsync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

it.each([
  ['application/pdf', 'document'],
  ['image/png', 'image'],
])('reads a picked %s through the supported file API and preserves its wire payload', async (mimeType, type) => {
  const uri = 'file:///cache/attachment';
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri, name: 'attachment', mimeType }] });
  mockRead.mockResolvedValue('YWJj');

  const attachment = await pickDocument();

  expect(mockPick).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: true }));
  expect(mockRead).toHaveBeenCalledWith(uri, { encoding: 'base64' });
  expect(attachment).toEqual(expect.objectContaining({ type, uri, data: 'YWJj', size: 3 }));
  expect(toWireAttachments([attachment!])).toEqual([
    { type, name: 'attachment', mediaType: mimeType, data: 'YWJj' },
  ]);
});
