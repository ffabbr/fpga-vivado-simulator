const origin = self.location.origin.replace(/^blob:/, '');
const originalFetch = self.fetch;
self.fetch = function(input, init) {
  if (typeof input === 'string' && input.startsWith('/')) {
    input = origin + input;
  }
  return originalFetch.call(this, input, init);
};
