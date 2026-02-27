import './style.css';

type Availability = {
  status: string;
  label: string;
};

type PartItem = {
  partNumber: string;
  name: string;
  price?: string;
  url: string;
  availability: Availability;
};

type PartsResponse = {
  prefix: string;
  limit: number;
  count: number;
  items: PartItem[];
};

async function fetchPrefix(prefix: string): Promise<PartsResponse> {
  const response = await fetch(`/api/parts?prefix=${encodeURIComponent(prefix)}&limit=100`);
  if (!response.ok) {
    throw new Error(`Request for ${prefix} failed with ${response.status}`);
  }
  return response.json() as Promise<PartsResponse>;
}

async function run(): Promise<void> {
  const [a309, a310] = await Promise.all([fetchPrefix('A309'), fetchPrefix('A310')]);

  const mergedByPartNumber = new Map<string, PartItem>();
  for (const item of [...a309.items, ...a310.items]) {
    if (!mergedByPartNumber.has(item.partNumber)) {
      mergedByPartNumber.set(item.partNumber, item);
    }
  }

  const mergedItems = Array.from(mergedByPartNumber.values());

  console.table(
    mergedItems.map((item) => ({
      partNumber: item.partNumber,
      name: item.name,
      price: item.price ?? '',
      availability: item.availability.label,
      url: item.url,
    })),
  );

  console.log({
    total: mergedItems.length,
    byPrefix: {
      A309: a309.count,
      A310: a310.count,
    },
  });
}

void run().catch((error) => {
  console.error('Failed to fetch parts', error);
});
