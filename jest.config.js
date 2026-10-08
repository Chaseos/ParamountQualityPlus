export default {
  testEnvironment: 'jsdom',
  verbose: true,
  // Private investigation harnesses use node:test, independently of Jest.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.local/'],
};
