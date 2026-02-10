import { OrganizerGalleryApp } from '../../../../src/OrganizerGalleryApp';

interface OrganizerGalleryPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default async function OrganizerGalleryPage({ params }: OrganizerGalleryPageProps) {
  const { id } = await params;
  return <OrganizerGalleryApp eventId={id} />;
}
