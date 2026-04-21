import { createSignal } from 'solid-js';
import { useNavigate, A } from '@solidjs/router';

export function Register() {
  const [name, setName] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const navigate = useNavigate();

  const handleRegister = async (e: Event) => {
    e.preventDefault();
    setError('');
    
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name(), email: email(), password: password() }),
      });
      
      if (res.ok) {
        navigate('/login');
      } else {
        const data = await res.json();
        setError(data.error || 'Registration failed');
      }
    } catch {
      setError('An error occurred. Please try again.');
    }
  };

  return (
    <div class="min-h-screen flex items-center justify-center bg-pattern p-4">
      <div class="glass-card w-full max-w-sm rounded-2xl p-8 animate-fade-in">
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-8 h-8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
            </svg>
          </div>
          <h2 class="text-3xl font-bold text-neutral">Create account</h2>
          <p class="text-sm opacity-85 mt-2">Start tracking your orders</p>
        </div>
        
        <form onSubmit={handleRegister} class="space-y-5">
          {error() && (
            <div class="alert alert-error py-3 text-sm rounded-xl">
              <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 w-5 h-5" fill="none" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{error()}</span>
            </div>
          )}
          
          <div class="form-control">
            <label class="label">
              <span class="label-text font-medium text-sm">Name</span>
            </label>
            <input 
              type="text" 
              placeholder="Your name" 
              class="input input-bordered w-full bg-base-100/75" 
              value={name()} 
              onInput={(e) => setName(e.currentTarget.value)} 
              required
            />
          </div>
          
          <div class="form-control">
            <label class="label">
              <span class="label-text font-medium text-sm">Email</span>
            </label>
            <input 
              type="email" 
              placeholder="you@example.com" 
              class="input input-bordered w-full bg-base-100/75" 
              value={email()} 
              onInput={(e) => setEmail(e.currentTarget.value)} 
              required
            />
          </div>
          
          <div class="form-control">
            <label class="label">
              <span class="label-text font-medium text-sm">Password</span>
            </label>
            <input 
              type="password" 
              placeholder="••••••••" 
              class="input input-bordered w-full bg-base-100/75" 
              value={password()} 
              onInput={(e) => setPassword(e.currentTarget.value)} 
              required
            />
          </div>
          
          <div class="form-control mt-6">
            <button type="submit" class="btn btn-primary w-full">Create Account</button>
          </div>
        </form>
        
        <div class="mt-6 text-center text-sm">
          <span class="opacity-85">Already have an account? </span>
          <A href="/login" class="font-medium text-primary hover:underline">Sign in</A>
        </div>
      </div>
    </div>
  );
}
