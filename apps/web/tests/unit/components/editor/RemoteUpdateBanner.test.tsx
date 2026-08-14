import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RemoteUpdateBanner } from '@/components/editor/RemoteUpdateBanner';
import { useProjectStore } from '@/store/useProjectStore';

describe('RemoteUpdateBanner', () => {
  afterEach(() => {
    act(() => {
      useProjectStore.setState({ remoteUpdateAvailable: false });
    });
  });

  it('renders nothing when no remote update is pending', () => {
    useProjectStore.setState({ remoteUpdateAvailable: false });
    const { container } = render(<RemoteUpdateBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the banner and reloads the project when the button is clicked', async () => {
    useProjectStore.setState({ remoteUpdateAvailable: true });
    const reloadSpy = vi.fn().mockReturnValue(undefined);
    // Replace the bound action with a spy for this assertion.
    useProjectStore.setState({ reloadFromRemote: reloadSpy });

    render(<RemoteUpdateBanner />);
    expect(screen.getByText(/远端有更新/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
