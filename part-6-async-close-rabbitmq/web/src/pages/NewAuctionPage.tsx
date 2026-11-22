import { useState, type FormEvent } from 'react';

import { useActiveUser } from '../activeUser';
import { AUCTION_CATEGORIES } from '../categories';
import { ProductArt } from '../components/ProductArt';
import type { Auction, ProductArtKind } from '../types';

function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isFinite(cents) ? cents : null;
}

function defaultClosingLocalValue(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function NewAuctionPage() {
  const { activeUser } = useActiveUser();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(AUCTION_CATEGORIES[0]?.category ?? 'GPUs');
  const [description, setDescription] = useState('');
  const [condition, setCondition] = useState('');
  const [location, setLocation] = useState('');
  const [startingPrice, setStartingPrice] = useState('100.00');
  const [closingLocal, setClosingLocal] = useState(defaultClosingLocalValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const art = (AUCTION_CATEGORIES.find((entry) => entry.category === category)?.art ??
    'gpu') as ProductArtKind;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!activeUser) {
      setError('Pick an active user in the footer before posting.');
      return;
    }

    const startingPriceCents = dollarsToCents(startingPrice);
    if (startingPriceCents === null || startingPriceCents <= 0) {
      setError('Starting price must be a positive dollar amount like 1234.50.');
      return;
    }

    const closingTime = new Date(closingLocal);
    if (Number.isNaN(closingTime.getTime()) || closingTime.getTime() <= Date.now()) {
      setError('Closing time must be a future date and time.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/auctions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellerId: activeUser.id,
          title: title.trim(),
          category,
          description: description.trim(),
          condition: condition.trim(),
          location: location.trim(),
          startingPriceCents,
          closingTime: closingTime.toISOString(),
        }),
      });
      const body = (await response.json()) as { auction?: Auction; error?: string };
      if (!response.ok || !body.auction) {
        setError(body.error ?? 'Could not create the auction.');
        return;
      }
      window.location.assign(`/auctions/${encodeURIComponent(body.auction.slug)}`);
    } catch {
      setError('Could not create the auction.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="container new-auction-page">
      <div className="breadcrumbs">
        <a href="/">Auction House</a>
        <span>/</span>
        <span>Sell</span>
      </div>

      <div className="new-auction-layout">
        <section className="new-auction-copy">
          <p className="eyebrow">Post an auction</p>
          <h1>List something for the floor.</h1>
          <p>
            You are posting as <strong>{activeUser?.displayName ?? 'no active user'}</strong>.
            Category picks the illustration — no uploads in this part.
          </p>
          <div className="new-auction-preview">
            <ProductArt kind={art} label={`Preview illustration for ${category}`} />
          </div>
        </section>

        <form className="new-auction-form" onSubmit={onSubmit}>
          <label>
            <span>Title</span>
            <input
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="NVIDIA H100 SXM 80GB"
            />
          </label>

          <label>
            <span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {AUCTION_CATEGORIES.map((entry) => (
                <option key={entry.category} value={entry.category}>
                  {entry.category}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Description</span>
            <textarea
              required
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is it, where has it been, and why should someone bid?"
            />
          </label>

          <div className="new-auction-row">
            <label>
              <span>Condition</span>
              <input
                required
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
                placeholder="Used · Fully tested"
              />
            </label>
            <label>
              <span>Location</span>
              <input
                required
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Austin, TX"
              />
            </label>
          </div>

          <div className="new-auction-row">
            <label>
              <span>Starting price (USD)</span>
              <input
                required
                inputMode="decimal"
                value={startingPrice}
                onChange={(event) => setStartingPrice(event.target.value)}
                placeholder="100.00"
              />
            </label>
            <label>
              <span>Closing time</span>
              <input
                required
                type="datetime-local"
                value={closingLocal}
                onChange={(event) => setClosingLocal(event.target.value)}
              />
            </label>
          </div>

          {error ? <p className="form-error" role="alert">{error}</p> : null}

          <button type="submit" disabled={submitting || !activeUser}>
            {submitting ? 'Posting…' : 'Post auction'}
          </button>
        </form>
      </div>
    </main>
  );
}
