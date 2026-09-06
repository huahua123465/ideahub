export function createFilterController({ load, onChange }) {
  let generation = 0;
  let state = { status: 'idle', filter: 'all', items: [], error: '' };
  const publish = patch => {
    state = { ...state, ...patch };
    onChange({ ...state });
  };

  return {
    getState: () => ({ ...state }),
    async select(filter) {
      const own = ++generation;
      publish({ status: 'loading', filter, items: [], error: '' });
      try {
        const items = await load(filter);
        if (own !== generation) return;
        publish({ status: 'ready', filter, items, error: '' });
      } catch (error) {
        if (own !== generation) return;
        publish({ status: 'error', filter, items: [], error: error?.message || '加载失败' });
      }
    },
  };
}
