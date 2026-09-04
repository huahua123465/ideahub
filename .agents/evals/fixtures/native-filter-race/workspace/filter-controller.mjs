export function createFilterController({ load, onChange }) {
  let state = { status: 'idle', filter: 'all', items: [], error: '' };
  const publish = patch => {
    state = { ...state, ...patch };
    onChange({ ...state });
  };

  return {
    getState: () => ({ ...state }),
    async select(filter) {
      publish({ status: 'loading', filter, error: '' });
      try {
        const items = await load(filter);
        publish({ status: 'ready', filter, items, error: '' });
      } catch (error) {
        publish({ status: 'error', filter, error: error?.message || '加载失败' });
      }
    },
  };
}
