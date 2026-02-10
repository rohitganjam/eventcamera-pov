import { GuestExperience } from '../../../src/guest/GuestExperience';

interface GuestEventPageProps {
  params: Promise<{
    slug: string;
  }>;
}

export default async function GuestEventPage({ params }: GuestEventPageProps) {
  const { slug } = await params;
  return <GuestExperience slug={slug} />;
}
