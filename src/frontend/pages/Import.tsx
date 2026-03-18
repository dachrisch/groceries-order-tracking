import { createSignal, Show } from 'solid-js';

export function Import() {
  const [curl, setCurl] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [result, setResult] = createSignal<any>(null);
  const [error, setError] = createSignal('');

  const handleImport = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curl: curl() }),
      });

      const data = await res.json();
      if (res.ok) {
        setResult(data);
        setCurl('');
      } else {
        setError(data.error || 'Import failed');
      }
    } catch (e) {
      setError('An error occurred during import.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="max-w-2xl mx-auto space-y-8">
      <h1 class="text-3xl font-bold">Import Knuspr Orders</h1>
      
      <div class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">Paste your cURL command</h2>
          <p class="text-sm opacity-70">
            Open <a href="https://www.knuspr.de/benutzer/profil" target="_blank" class="link link-primary">Knuspr Profile</a>, 
            inspect network, find <code>delivered?offset=0...</code> request, right click -&gt; Copy as cURL.
          </p>
          
          <form onSubmit={handleImport} class="space-y-4 mt-4">
            <div class="form-control">
              <textarea 
                class="textarea textarea-bordered h-48 font-mono text-xs" 
                placeholder="curl 'https://www.knuspr.de/api/v3/orders/delivered...' -H ..."
                value={curl()}
                onInput={(e) => setCurl(e.currentTarget.value)}
                required
              ></textarea>
            </div>
            
            <button 
              type="submit" 
              class="btn btn-primary w-full"
              disabled={loading()}
            >
              <Show when={loading()}>
                <span class="loading loading-spinner"></span>
              </Show>
              Start Import
            </button>
          </form>

          <Show when={error()}>
            <div class="alert alert-error mt-4">
              <span>{error()}</span>
            </div>
          </Show>

          <Show when={result()}>
            <div class="alert alert-success mt-4">
              <span>Successfully imported {result().importedCount} new orders!</span>
            </div>
          </Show>
        </div>
      </div>

      <div class="collapse collapse-arrow bg-base-100 shadow-xl">
        <input type="checkbox" /> 
        <div class="collapse-title text-xl font-medium">
          How it works
        </div>
        <div class="collapse-content space-y-2 text-sm">
          <p>This app needs your Knuspr session cookies to fetch your order history.</p>
          <p>By pasting the cURL command, you provide the necessary headers and cookies. The app will:</p>
          <ul class="list-disc ml-6">
            <li>Parse the headers from the command</li>
            <li>Use them to fetch all "DELIVERED" orders</li>
            <li>Store order details and item prices in your private account</li>
            <li>Update your dashboard with spend and price trends</li>
          </ul>
          <p class="mt-2 font-bold text-warning">Note: Credentials are stored to allow "Update" in the future without re-pasting, until the session expires.</p>
        </div>
      </div>
    </div>
  );
}
