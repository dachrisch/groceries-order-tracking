import { createSignal } from 'solid-js';
import { useNavigate, A } from '@solidjs/router';

export function Login() {
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const navigate = useNavigate();

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    setError('');
    
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email(), password: password() }),
      });
      
      if (res.ok) {
        window.location.href = '/';
      } else {
        const data = await res.json();
        setError(data.error || 'Login failed');
      }
    } catch (e) {
      setError('An error occurred. Please try again.');
    }
  };

  return (
    <div class="flex items-center justify-center min-h-screen bg-base-300">
      <div class="card w-96 bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title text-2xl font-bold mb-4">Login</h2>
          <form onSubmit={handleLogin} class="space-y-4">
            {error() && (
              <div class="alert alert-error py-2 text-sm">
                <span>{error()}</span>
              </div>
            )}
            <div class="form-control">
              <label class="label">
                <span class="label-text">Email</span>
              </label>
              <input 
                type="email" 
                placeholder="email@example.com" 
                class="input input-bordered" 
                value={email()} 
                onInput={(e) => setEmail(e.currentTarget.value)} 
                required
              />
            </div>
            <div class="form-control">
              <label class="label">
                <span class="label-text">Password</span>
              </label>
              <input 
                type="password" 
                placeholder="••••••••" 
                class="input input-bordered" 
                value={password()} 
                onInput={(e) => setPassword(e.currentTarget.value)} 
                required
              />
            </div>
            <div class="form-control mt-6">
              <button type="submit" class="btn btn-primary">Login</button>
            </div>
          </form>
          <div class="mt-4 text-center text-sm">
            Don't have an account? <A href="/register" class="link link-primary">Register</A>
          </div>
        </div>
      </div>
    </div>
  );
}
