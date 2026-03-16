import * as fs from 'fs';
import * as path from 'path';

const srcPath = path.resolve(__dirname, '../../components/FileEditor.tsx');
const source = fs.readFileSync(srcPath, 'utf-8');

describe('FileEditor', () => {
  describe('source scan', () => {
    it('exports FileEditor as a named export', () => {
      expect(source).toMatch(/export\s+function\s+FileEditor/);
    });

    it('accepts visible, filePath, initialContent, onClose, and onSave props', () => {
      expect(source).toContain('visible');
      expect(source).toContain('filePath');
      expect(source).toContain('initialContent');
      expect(source).toContain('onClose');
      expect(source).toContain('onSave');
    });

    it('renders a Modal component', () => {
      expect(source).toContain('<Modal');
    });

    it('uses a multiline TextInput for editing', () => {
      expect(source).toContain('<TextInput');
      expect(source).toContain('multiline');
    });

    it('uses monospace font for the editor', () => {
      expect(source).toContain('Menlo');
      expect(source).toContain('monospace');
    });

    it('shows a confirm dialog before saving', () => {
      expect(source).toContain('Alert.alert');
      expect(source).toContain('Save Changes');
    });

    it('warns before discarding unsaved changes', () => {
      expect(source).toContain('Discard Changes');
      expect(source).toContain('unsaved changes');
    });

    it('uses requestFileWrite from the connection store', () => {
      expect(source).toContain('requestFileWrite');
    });

    it('uses setFileWriteCallback from the connection store', () => {
      expect(source).toContain('setFileWriteCallback');
    });

    it('has a save timeout fallback', () => {
      expect(source).toContain('Request timed out');
    });

    it('has Cancel editing and Save file accessibility labels', () => {
      expect(source).toContain('Cancel editing');
      expect(source).toContain('Save file');
    });

    it('shows a Modified badge when content differs from initial', () => {
      expect(source).toContain('Modified');
      expect(source).toContain('hasChanges');
    });

    it('disables editing while saving', () => {
      expect(source).toContain('editable={!saving}');
    });

    it('renders SyntaxHighlightedCode in view mode', () => {
      expect(source).toContain('SyntaxHighlightedCode');
      expect(source).toContain('langFromPath');
    });

    it('tracks isEditing state to switch between view and edit modes', () => {
      expect(source).toContain('isEditing');
      expect(source).toContain('setIsEditing');
    });

    it('shows an Edit button in view mode to enter editing', () => {
      expect(source).toContain('Edit file');
      expect(source).toContain("setIsEditing(true)");
    });

    it('shows a Done button label in view mode', () => {
      expect(source).toContain("'Done'");
    });

    it('resets isEditing to false when modal opens with new file', () => {
      // Confirm setIsEditing(false) is called inside the visible effect
      expect(source).toContain('setIsEditing(false)');
    });

    it('imports SyntaxHighlightedCode and langFromPath from PermissionDetail', () => {
      expect(source).toContain("from './PermissionDetail'");
    });
  });
});
