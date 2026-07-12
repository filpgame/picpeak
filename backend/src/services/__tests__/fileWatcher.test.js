jest.mock('chokidar');
jest.mock('../../database/db');
jest.mock('../../utils/logger');
jest.mock('../imageProcessor');
jest.mock('../videoProcessor', () => ({
  isVideoMimeType: jest.fn().mockReturnValue(false),
}));
jest.mock('../downloadZipService', () => ({ invalidate: jest.fn() }));
jest.mock('../webhookService', () => ({ fire: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/dbCompat', () => ({ formatBoolean: jest.fn((v) => v) }));
jest.mock('mime-types');

const chokidar = require('chokidar');
const { db } = require('../../database/db');
const { generateThumbnail } = require('../imageProcessor');
const mime = require('mime-types');

const mockWatcher = { on: jest.fn().mockReturnThis() };
chokidar.watch = jest.fn().mockReturnValue(mockWatcher);

const { processNewPhoto } = require('../fileWatcher');

// Helper — path inside WATCH_PATH (/test-storage/events/active)
const watchedPath = (slug, filename) =>
  `/test-storage/events/active/${slug}/${filename}`;

describe('processNewPhoto', () => {
  let savedStoragePath;

  beforeAll(() => {
    savedStoragePath = process.env.STORAGE_PATH;
    process.env.STORAGE_PATH = '/test-storage';
  });

  afterAll(() => {
    process.env.STORAGE_PATH = savedStoragePath;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mime.lookup = jest.fn().mockReturnValue('image/jpeg');
  });

  it('skips files with temp_ prefix', async () => {
    await processNewPhoto(watchedPath('my-event', 'temp_123_456.jpg'));
    expect(db).not.toHaveBeenCalled();
  });

  it('skips non-image/video extensions', async () => {
    mime.lookup = jest.fn().mockReturnValue('text/plain');
    await processNewPhoto(watchedPath('my-event', 'readme.txt'));
    expect(db).not.toHaveBeenCalled();
  });

  it('skips when event not found in DB', async () => {
    const mockQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    db.mockReturnValue(mockQuery);
    await processNewPhoto(watchedPath('missing-event', 'photo.jpg'));
    expect(generateThumbnail).not.toHaveBeenCalled();
  });
});
