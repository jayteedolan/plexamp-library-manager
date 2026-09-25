from app.providers.base import SearchProvider
from app.providers.soulseek import SoulseekProvider

PROVIDERS: dict[str, type[SearchProvider]] = {
    SoulseekProvider.key: SoulseekProvider,
}
